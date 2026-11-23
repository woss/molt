# molt — local semantic context optimizer for omp

## Context

Build a new omp extension, **molt** (`~/projects/woss/molt`, npm package name `omp-molt`), that does what Sleev does locally: permanently shrinks session context by LLM-summarizing stale conversation ranges, scheduling rewrites only when projected savings beat the one-time prompt-cache bust. This replaces the structural-compression role of the `omp-headroom` fork (which trims requests but never shrinks history). User decisions: name `molt`; headroom is **disabled after parity** (not uninstalled); summarizer model is **configurable, default omp `@smol` role**.

Verified ground truth this plan relies on:
- omp extension API (docs/extensions.md on can1357/oh-my-pi): `pi.on(...)`, `pi.registerTool`, `pi.registerCommand`, `pi.appendEntry(customType, data)` + `ctx.sessionManager.getBranch()` for persistence, `ctx.getContextUsage()`, `ctx.models.resolve(spec)` / `ctx.models.current()`, `before_agent_start` returns `{systemPrompt}`, `context` event receives `{messages}` and returns `{messages}`, `tool_call`/`tool_result` events, 30s handler budget (2s on `session_shutdown`).
- Model invocation from an extension: `import { complete } from "@oh-my-pi/pi-ai"` with a model from `ctx.models.resolve(selector)` — proven pattern from alesha-pro/omp-statecompact `src/index.ts:4,115,231`.
- Splice machinery to port: complexthings/pi-dynamic-context-pruning (`pruner.ts`, `state.ts`, `compress-tool.ts`) — full shapes and pipeline captured in DcpScan findings below.
- Real-spend source: `message_end` carries `event.message.usage` with `{input, cacheRead, cacheWrite, cost:{total}}` at real provider rates (verified in session JSONL and fork `src/index.ts:2020` handler).
- Packaging: package.json `"omp": { "extensions": ["./src/index.ts"] }`, `type: "module"`, `"exports": "./src/index.ts"` (fork-omp-headroom package.json); install via `omp plugin install <pkg>`.

## Approach

Steps 1–7 build one extension; each step ends with `npx tsc --noEmit` + `npx vitest run` passing in `~/projects/woss/molt`. Steps are ordered by dependency; within a step files are created together. Step 9 is independent of 8.

### 1. Scaffold

Create `~/projects/woss/molt` with:

- `package.json`: `{ "name": "omp-molt", "version": "0.1.0", "type": "module", "exports": "./src/index.ts", "omp": { "extensions": ["./src/index.ts"] }, "files": ["src", "README.md"], "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" }, "devDependencies": { "@oh-my-pi/pi-coding-agent": "*", "@oh-my-pi/pi-ai": "*", "typescript": "^5.9.3", "vitest": "^5.1.1" } }` — devDependency versions copied from what `~/projects/forks/fork-omp-headroom` resolves (check its node_modules; its package.json does not pin pi-coding-agent, so read `bun.lock`/`node_modules/@oh-my-pi/pi-coding-agent/package.json` version and pin that).
- `tsconfig.json`: strict, `module: NodeNext`, `noEmit`, types from `@oh-my-pi/pi-coding-agent` (copy shape from fork `tsconfig.json`).
- `src/index.ts` placeholder exporting the factory from step 8.
- Install deps with bun (`bun install`) — fork uses bun; use bun, not npm.

### 2. `src/state.ts` — block/record shapes (port from pi-dcp `state.ts`)

Port the DCP state shapes verbatim with molt naming; no logic changes:

- `CompressionBlock { id, topic, summary, startTimestamp, endTimestamp, anchorTimestamp, active, summaryTokenEstimate, createdAt }` — identical fields/semantics (timestamps are omp message `timestamp` values; `anchorTimestamp` = first message ts AFTER range, `Infinity` allowed in-memory, never persisted as Infinity — persist `null`, repair to `endTimestamp + 0.5` on load, as DCP does).
- `ToolRecord { toolCallId, toolName, inputArgs, inputFingerprint, isError, turnIndex, timestamp, tokenEstimate }`.
- `MoltState { toolCalls: Map<string,ToolRecord>, prunedToolIds: Set<string>, compressionBlocks: CompressionBlock[], nextBlockId: number, messageIdSnapshot: Map<string,number>, currentTurn: number, realSpendUsd: number, cacheReadTokens: number, cacheWriteTokens: number, inputTokens: number, tokensSaved: number, manualMode: boolean }` — `realSpendUsd`/token counters replace DCP's savings counters.
- `createInputFingerprint(toolName, args)` = `` `${toolName}::${JSON.stringify(sortObjectKeys(args))} `` with recursive key sort — copy DCP exactly.
- Persistence round-trip functions `serializeMoltState(state)` / `deserializeMoltState(raw)`: Map/Set ↔ arrays, Infinity↔null repair. Tag strings: `<molt-id>mNNN</molt-id>`, `<molt-block-id>bN</molt-block-id>` (all DCP `dcp-*` tag names renamed).

### 3. `src/telemetry.ts` — real-spend + cache economics

- `recordUsage(state, usage)`: on `message_end`, accumulate `usage.input`, `usage.cacheRead`, `usage.cacheWrite` (clamp negatives to 0, fork pattern) and `usage.cost.total` into `state.realSpendUsd`. `usage` is the finalized assistant message usage snapshot — same fields the paseo-headroom panel parses from session JSONL.
- `cacheEconomics(model)`: from `ctx.model.cost` (`{input, cacheRead, cacheWrite}` in $/token, fork `src/session-pricing.ts` pattern) return `{readRate, writeRate}`; when cost fields are missing, fall back to `{readRate: 0, writeRate: 0}` — scheduler treats cache cost as 0 (favor rewriting).
- `projectBustCostUsd(state, model)`: `contextTokens * (writeRate - readRate)` where `contextTokens` comes from `ctx.getContextUsage().tokens`.

### 4. `src/scheduler.ts` — the cache-cost policy (new logic, unit-test core)

- `shouldAutoMolt(ctx, state, config)` returns `{ fire: boolean, candidateRanges: Range[] }`.
- Fire conditions (all required): auto mode on; `usageRatio = tokens/contextWindow > config.maxContextPercent` (default `0.70`); `cacheEconomics` computed; candidates exist.
- Candidates: completed `toolResult` records where `state.currentTurn - record.turnIndex >= config.protectTurns` (default `2`), tool not in protected set (`{"molt_expand","molt","write","edit"}`), grouped into contiguous ranges of at most `config.maxRangeTokens` (default `20000` estimated tokens, `len/4` estimate), ranked by `record.tokenEstimate` descending.
- Net-savings gate: `projectSavingsUsd = candidateTokens * readRate - projectBustCostUsd(state) - summarizerCostEstimate` where `summarizerCostEstimate = 1000 * resolvedModel.cost.input + 600 * resolvedModel.cost.output`; fire only when `> 0` OR when both rates are 0 (unknown pricing) and `candidateTokens > 20000`. This is the only policy in the codebase — no adaptive-threshold port from the fork.
- `config` type lives here: `{ maxContextPercent: 0.7, protectTurns: 2, maxRangeTokens: 20000, auto: true, model: "@smol" }` with loader `loadConfig(cwd)` reading `.omp/molt.json` (JSON, only overrides: deep-merge onto defaults; missing file = defaults) — mirrors omp-statecompact config loading.

### 5. `src/summarizer.ts` — LLM summary of ranges

- `summarizeRanges(ctx, ranges, messages, config)`: resolve model via `ctx.models.resolve(config.model)`; on `undefined`, throw `"molt: model <spec> not resolvable"`. Build one prompt (system text in `src/prompt.ts` as a template literal — no equivalent exists): "You compress stale agent conversation ranges. Return JSON {topic, ranges:[{startId,endId,summary}]} where each summary is an exhaustive technical summary preserving file paths, commands, errors, decisions, and current values; omit nothing a later engineer needs."
- Call via `complete(model, ...)` — exact call shape copied from omp-statecompact `src/index.ts:230-240` (read it before writing; it constructs the request and reads `{stopReason, errorMessage, output, usage}`).
- Validate: parse JSON, every range id resolves via the same id→timestamp logic as the compress tool, reject overlapping ranges (DCP overlap check). On parse failure retry once with DCP's repair-input pattern (append rejected output + rejection reason). Two failures → throw; caller logs and skips (never blocks the turn).

### 6. `src/splicer.ts` — context transform (port pi-dcp `pruner.ts` pipeline)

Port `applyPruning` verbatim in behavior, molt naming:

- Pipeline order: clone messages → count turns → apply compression blocks → repair orphaned pairs → dedup → error purge → inject message ids.
- Compression-block splice: expand `lo` backward/`hi` forward to keep assistant↔toolCall/toolResult groups atomic (DCP expansion logic including passthrough roles `compaction`, `branch_summary`, `custom_message`), `messages.splice(lo, hi-lo+1)`, insert synthetic user message `"[Molted section: <topic>]\n\n<summary>\n\n<molt-block-id>bN</molt-block-id>"` at `anchorTimestamp - 0.5`, re-sort by timestamp.
- `repairOrphanedToolPairs`: drop toolResults without matching assistant toolCall; strip orphaned toolCall blocks.
- Dedup: group toolResults by `inputFingerprint`, all-but-last replaced in place with `"[Output removed — duplicate of a later identical call]"` (structure preserved). Error purge: `"[Error output removed]"` after `protectTurns`.
- Id injection: `stripExistingMessageIds` regex `/\s*<molt-id>m\d+<\/molt-id>/g` first (idempotent passes), then sequential `mNNN` ids appended per DCP placement rules (assistant: before first toolCall block).

### 7. `src/archive.ts` + `src/tools.ts` — originals + tools

- `archive.ts`: `persistOriginal(messages, state)` → writes minified JSON to `~/.omp/agent/molt-archive/<sha256-slice-24>.json` (mkdir recursive; fork `ccr.ts` `persistCcrOriginal` is the pattern — read it). Returns the hash. No TTL/cleanup (matches fork).
- `tools.ts`:
  - `molt` tool (model-invoked compress, port of DCP compress-tool): params `{topic: string, ranges: [{startId, endId, summary}]}` via `pi.zod`; overlap validation, `(bN)` placeholder expansion, block creation. The model chooses ranges using `<molt-id>` markers.
  - `molt_expand` tool: param `{hash: string}`; reads `~/.omp/agent/molt-archive/<hash>.json`, returns `{content:[{type:"text", text: original}]}`; missing file → error content, not throw.
- Summaries produced by the scheduler path embed `Expand originals: molt_expand hash=<hash>` marker (fork CCR marker convention).

### 8. `src/index.ts` — wiring

`export default function molt(pi: ExtensionAPI)`:

- `session_start`: `loadConfig(cwd)`; restore state by walking `ctx.sessionManager.getBranch()` for last `entry.type === "custom" && entry.customType === "molt-state"` → `deserializeMoltState`.
- `before_agent_start`: append molt system prompt (tool usage guidance, DCP `SYSTEM_PROMPT` conventions, molt naming).
- `tool_call` / `tool_result`: record `ToolRecord`s (fingerprint, turnIndex, tokenEstimate).
- `message_end`: `recordUsage` (assistant messages only, `isMainSession`-style guard copied from fork `src/index.ts:2020-2030`).
- `context`: `applyPruning` → return `{messages}`; then scheduler: if `shouldAutoMolt` fires, run `summarizeRanges` + `persistOriginal` + push blocks **asynchronously** via `pi.setTimeout` (managed timer; never inside the handler — 30s budget) so blocks apply on the next context event. Guard: one in-flight auto-molt (module-level flag).
- Nudges: port DCP nudge typing (`context-strong`/`context-soft`/`turn`/`iteration`) with `<molt-system-reminder>` strings; skipped in manual mode.
- `session_shutdown`: `pi.appendEntry("molt-state", serializeMoltState(state))` — also append after every `agent_end` (DCP cadence).
- `registerCommand("molt", ...)`: subcommands `stats` (blocks, saved tokens, real spend, cache totals), `auto on|off`, `sweep [N]` (mark last N tool outputs for immediate summarization).

### 9. Companion plugins + headroom cutover (independent of 8)

Run in order after step 8 verifies:

1. `omp plugin install github:zhulinchng/omp-vcc` — lossless no-LLM compaction with recall (`/omp-vcc`, `vcc_recall`); covers the compaction path molt does not.
2. `omp plugin install github:alesha-pro/omp-statecompact` — canonical mutable-state compaction; validates its own output and falls back to native omp compaction.
3. `omp plugin doctor` — both report loaded.
4. Only after molt live-verification (below): `omp plugin disable omp-headroom` — keeps the venv/proxy on disk, stops the extension. If the user asks to re-enable: `omp plugin enable omp-headroom`.

## Critical files & anchors

- `~/projects/forks/fork-omp-headroom/src/index.ts:1960-2110` — hook wiring to mirror (`session_start`, `message_end` main-session guard, `session.compacting`, `before_provider_request` payload shape).
- `~/projects/forks/fork-omp-headroom/src/session-pricing.ts` — `ctx.model.cost` real-rate extraction pattern reused by `telemetry.ts`.
- `~/projects/forks/fork-omp-headroom/src/ccr.ts` — archive write pattern reused by `archive.ts`.
- `~/projects/forks/fork-omp-headroom/package.json` — `omp.extensions` manifest shape.
- `~/projects/woss/paseo-headroom/server/headroom.ts:136-169` (`parseSessionUsage`) — not reused directly (this plugin reads usage from hooks, not JSONL), but documents the usage field semantics `telemetry.ts` relies on.

pi-dcp sources are read from GitHub (URLs in DcpScan report); port from that captured logic, do not fetch at implementation time — clone `https://github.com/complexthings/pi-dynamic-context-pruning` to `/tmp` if the report is insufficient for a specific function.

## Verification

1. Unit: `cd ~/projects/woss/molt && npx vitest run` — required new-behavior tests:
   - splicer: a range spanning an assistant toolCall + its toolResult splices as one unit; a hand-built orphaned toolResult is removed by the repair pass; id injection is idempotent across two passes.
   - scheduler: with `readRate=0.0000005, writeRate=0.00000375`, context 200k tokens, candidates 30k tokens → fires; with cache rates 0 and candidates 5k tokens → does not fire (decision table test).
   - state: serialize→deserialize round-trip preserves blocks incl. `anchorTimestamp: Infinity` case.
   - telemetry: three synthetic `message_end` usages sum `realSpendUsd` to the penny of `cost.total`.
2. Typecheck: `npx tsc --noEmit` clean.
3. Live end-to-end (the new-behavior proof):
   - `omp plugin install ~/projects/woss/molt && omp plugin doctor` → loaded, no errors.
   - Start a real session in any repo, run ~15 turns of tool-heavy work (file reads + bash). Run `/molt stats` → expect ≥1 compression block OR `auto` firing logged, `real spend` matching `~/.omp/agent/sessions/<slug>/<session>.jsonl` summed `usage.cost.total` (cross-check with the paseo-headroom panel's token sums for the same session id).
   - Confirm cache health: `cacheRead/(input+cacheRead+cacheWrite)` over post-molt messages stays ≥90% (same computation as the paseo-headroom pill) — proves the scheduler is not busting cache per request.
   - `molt_expand <hash>` on a summary's hash returns the original messages verbatim.
4. Cutover: `omp plugin disable omp-headroom`, restart a session, confirm `/molt stats` still accumulates and no headroom proxy process listens on 8787 (`lsof -iTCP:8787` empty or only foreign processes).

## Assumptions & contingencies

- `@smol` role resolves (user config.yml has `smol: opencode-zen/gpt-6-luna`). If `ctx.models.resolve("@smol")` returns undefined at runtime, molt logs one warning and uses `ctx.models.current()` for the session — decided now so the scheduler never stalls.
- `complete` from `@oh-my-pi/pi-ai` is the documented-model-call path; its exact parameter shape is unverified — implementer reads omp-statecompact `src/index.ts:225-245` first (it compiles against the same package versions) and mirrors that call. If `complete` proves incompatible with the pinned pi-ai version, fall back to `ctx.runEphemeralTurn` on the session model (works, but costs session-model rates and uses current context — acceptable degradation, note it in `/molt stats` output).
- `devDependencies` versions for `@oh-my-pi/pi-coding-agent`/`pi-ai` must match what the running omp binary bundles (fork `bun.lock` is the reference); if typecheck fails on API shapes, pin to the fork's resolved versions rather than `*`.
- omp-vcc/statecompact install steps may fail if the repos move — they are independent of molt; on failure, report and continue (molt does not depend on them).
