// molt — extension wiring for omp

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { persistOriginal } from "./archive.ts";
import {
	CONTEXT_SOFT_NUDGE,
	CONTEXT_STRONG_NUDGE,
	ITERATION_NUDGE,
	MOLT_SYSTEM_PROMPT,
	TURN_NUDGE,
} from "./prompt.ts";
import {
	createState,
	deserializeMoltState,
	serializeMoltState,
	createInputFingerprint,
	type MoltState,
} from "./state.ts";
import { loadConfig, shouldAutoMolt, type MoltConfig } from "./scheduler.ts";
import { summarizeRanges } from "./summarizer.ts";
import { applyPruning, collectRangeMessages, estimateMessageTokens, estimateRangeSourceTokens, estimateTokens } from "./splicer.ts";
import { cacheEconomics } from "./telemetry.ts";
import { createBlocks, registerTools } from "./tools.ts";

type AnyMsg = Record<string, any>;

export default function molt(pi: ExtensionAPI) {
	const config: MoltConfig = loadConfig(process.cwd());
	const state: MoltState = createState();
	state.manualMode = !config.auto;
	let latestCtx: any = null;
	let autoMoltInFlight = false;

	registerTools(pi, state);

	// ── session_start: restore persisted state ───────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (ctx?.hasUI) latestCtx = ctx;
		for (const entry of ctx.sessionManager.getBranch()) {
			if ((entry as any).type === "custom" && (entry as any).customType === "molt-state") {
				const restored = deserializeMoltState((entry as any).data);
				if (restored) Object.assign(state, restored);
			}
		}
	});

	// ── session_shutdown / agent_end: persist state ─────────────────────────
	const saveState = () => {
		pi.appendEntry("molt-state", serializeMoltState(state));
	};
	pi.on("session_shutdown", async () => saveState());
	pi.on("agent_end", async () => saveState());

	// ── before_agent_start: molt guidance on the system prompt ──────────────
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: [...event.systemPrompt, MOLT_SYSTEM_PROMPT],
	}));

	// ── tool_call / tool_result: record ToolRecords ─────────────────────────
	pi.on("tool_call", async (event) => {
		if (state.toolCalls.has(event.toolCallId)) return;
		state.toolCalls.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			inputArgs: (event.input ?? {}) as Record<string, unknown>,
			inputFingerprint: createInputFingerprint(event.toolName, (event.input ?? {}) as Record<string, unknown>),
			isError: false,
			turnIndex: state.currentTurn,
			timestamp: 0,
			tokenEstimate: 0,
		});
	});

	pi.on("tool_result", async (event) => {
		const outputText = Array.isArray(event.content)
			? event.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("")
			: "";
		const tokenEstimate = Math.round(outputText.length / 4);
		const record = state.toolCalls.get(event.toolCallId);
		if (record) {
			record.isError = event.isError === true;
			record.timestamp = Date.now();
			record.tokenEstimate = tokenEstimate;
		} else {
			state.toolCalls.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName ?? "",
				inputArgs: {},
				inputFingerprint: createInputFingerprint(event.toolName ?? "", {}),
				isError: event.isError === true,
				turnIndex: state.currentTurn,
				timestamp: Date.now(),
				tokenEstimate,
			});
		}
	});

	// ── message_end: real spend (main session assistant messages only) ──────
	pi.on("message_end", async (event, ctx) => {
		if (!ctx?.hasUI || (event.message as AnyMsg)?.role !== "assistant") return;
		recordUsageFromMessage(state, event.message);
		// Remember live model rates so consumers can price avoided tokens.
		const econ = cacheEconomics(ctx?.model);
		if (econ.readRate > 0 || econ.writeRate > 0) {
			state.readRate = econ.readRate;
			state.writeRate = econ.writeRate;
		}
	});

	function recordUsageFromMessage(state: MoltState, message: AnyMsg): void {
		const usage = message?.usage;
		if (!usage || typeof usage !== "object") return;
		const asNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		state.inputTokens += Math.max(0, asNum(usage.input));
		state.cacheReadTokens += Math.max(0, asNum(usage.cacheRead));
		state.cacheWriteTokens += Math.max(0, asNum(usage.cacheWrite));
		const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : {};
		state.realSpendUsd += Math.max(0, asNum(cost.total));
	}

	// ── context: prune transform, then schedule auto-molt off-band ──────────
	pi.on("context", async (event, ctx) => {
		const tokensBefore = (event.messages as AnyMsg[]).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
		const messages = applyPruning(event.messages as AnyMsg[], state, config.protectTurns);
		const tokensAfter = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

		// Append-only per-pass metric row: the transform's one-time shrink, this request.
		const passSaved = tokensBefore - tokensAfter;
		if (passSaved > 0) {
			pi.appendEntry("molt-metric", {
				kind: "pass",
				ts: Date.now(),
				tokensBefore,
				tokensAfter,
				savedTokens: passSaved,
				activeBlocks: state.compressionBlocks.filter((b) => b.active).length,
			});
		}

		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? 0;
		const economics = cacheEconomics(ctx?.model);

		if (!state.manualMode && usage?.contextWindow && !autoMoltInFlight) {
			const decision = shouldAutoMolt(state, config, economics, tokens, usage.contextWindow, ctx?.model);
			if (decision.fire && decision.candidateRanges.length > 0) {
				autoMoltInFlight = true;
				void runAutoMolt(decision.candidateRanges.flatMap((r) => r.toolCallIds))
					.catch((error) => pi.logger?.warn?.(`molt: auto-molt skipped: ${formatError(error)}`))
					.finally(() => {
						autoMoltInFlight = false;
					});
			}
		}

		// Nudges (skipped in manual mode).
		if (!state.manualMode && usage?.contextWindow && usage.contextWindow > 0) {
			const percent = tokens / usage.contextWindow;
			let nudge: string | null = null;
			if (percent > config.maxContextPercent) nudge = CONTEXT_STRONG_NUDGE;
			else if (percent > config.maxContextPercent * 0.8) nudge = CONTEXT_SOFT_NUDGE;
			else if (state.currentTurn % 4 === 3) nudge = TURN_NUDGE;
			else if (messages.filter((m) => m.role === "toolResult").length % 8 === 7) nudge = ITERATION_NUDGE;
			if (nudge) {
				messages.push({ role: "user", content: nudge, timestamp: Date.now() });
			}
		}

		return { messages: messages as never[] };
	});

	// Runs outside the context handler (pi.setTimeout-style managed async):
	// summarize candidate ranges, archive originals, push blocks for the next pass.
	async function runAutoMolt(toolCallIds: string[]): Promise<void> {
		const ctx = latestCtx;
		if (!ctx) return;
		const messages = ctx.sessionManager?.getBranch?.().filter((e: any) => e.messages).flatMap((e: any) => e.messages) ?? [];
		const idTargets = toolCallIds
			.map((id) => state.toolCalls.get(id))
			.filter((r): r is NonNullable<typeof r> => r !== undefined && r.timestamp > 0);
		if (idTargets.length === 0) return;
		const ranges = idTargets.map((r) => {
			const msgId = findMessageIdByTimestamp(state, r.timestamp);
			return { startId: msgId, endId: msgId };
		});

		const model = await ctx.models.resolve(config.model);
		const resolved = model ?? (await ctx.models.resolve("current")) ?? ctx.models.current();
		const summary = await summarizeRanges({ ...ctx, models: { resolve: () => Promise.resolve(resolved) } }, ranges, messages, {
			model: config.model,
		}, state);

		// Archive the raw messages inside the summarized ranges, then embed the marker.
		const originals = collectRangeMessages(messages, state, summary.ranges);
		const hash = await persistOriginal(originals);

		const taggedRanges = summary.ranges.map((r) => ({
			...r,
			summary: `${r.summary}\n\nExpand originals: molt_expand hash=${hash}`,
		}));
		const sourceTokens = estimateRangeSourceTokens(messages, state, summary.ranges);
		createBlocks(summary.topic, taggedRanges, state, sourceTokens);
		const sourceTotal = sourceTokens.reduce((a, b) => a + b, 0);
		const summaryTotal = taggedRanges.reduce((a, r) => a + estimateTokens(r.summary), 0);
		pi.appendEntry("molt-metric", {
			kind: "block",
			ts: Date.now(),
			topic: summary.topic,
			sourceTokens: sourceTotal,
			summaryTokens: summaryTotal,
			savedTokens: Math.max(0, sourceTotal - summaryTotal),
		});
		pi.logger?.info?.(`molt: auto-molted ${taggedRanges.length} range(s), archive hash ${hash}`);
	}

	// Nudge typing helper used above; DCP ports: context-strong/soft, turn, iteration.
	function formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

function findMessageIdByTimestamp(state: MoltState, timestamp: number): string {
	let best: { id: string; ts: number } | undefined;
	for (const [id, ts] of state.messageIdSnapshot) {
		if (ts === timestamp && (!best || ts < best.ts)) best = { id, ts };
	}
	return best?.id ?? "m001";
}
