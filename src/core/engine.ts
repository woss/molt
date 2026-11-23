// molt — engine: host-agnostic wiring of scheduler, splicer, telemetry, tools.
// Talks to the host exclusively through the HostAdapter/Summarizer boundary (../types.ts).

import { persistOriginal } from "./archive.ts";
import { CONTEXT_SOFT_NUDGE, CONTEXT_STRONG_NUDGE, ITERATION_NUDGE, TURN_NUDGE } from "./prompt.ts";
import { loadConfig, shouldAutoMolt, type MoltConfig } from "./scheduler.ts";
import { type MoltState, type ToolRecord } from "./state.ts";
import {
	applyPruning,
	collectRangeMessages,
	estimateMessageTokens,
	estimateRangeSourceTokens,
	estimateTokens,
} from "./splicer.ts";
import { summarizeRanges } from "./summarizer.ts";
import { cacheEconomics } from "./telemetry.ts";
import { createBlocks, createTools } from "./tools.ts";
import type { ContextEvent, ContextEventResult, HostAdapter, Summarizer, TelemetrySpend } from "../types.ts";

export function molt(adapter: HostAdapter, summarizer?: Summarizer): void {
	const config: MoltConfig = loadConfig(process.cwd());
	const state: MoltState = adapter.state;
	state.manualMode = !config.auto;
	let autoMoltInFlight = false;

	adapter.registerTools(createTools(adapter, state));

	// ── tool activity: store ToolRecords the adapter built ───────────────────
	adapter.onToolRecord((record) => {
		if (!state.toolCalls.has(record.toolCallId)) state.toolCalls.set(record.toolCallId, record);
	});

	// ── message_end: real spend + live model rates ──────────────────────────
	adapter.onMessageEnd((spend: TelemetrySpend) => {
		state.inputTokens += Math.max(0, spend.inputTokens);
		state.cacheReadTokens += Math.max(0, spend.cacheReadTokens);
		state.cacheWriteTokens += Math.max(0, spend.cacheWriteTokens);
		state.realSpendUsd += Math.max(0, spend.spendUsd);
		// Remember live model rates so consumers can price avoided tokens.
		if (spend.readRate > 0 || spend.writeRate > 0) {
			state.readRate = spend.readRate;
			state.writeRate = spend.writeRate;
		}
	});

	// ── context: prune transform, then schedule auto-molt off-band ──────────
	adapter.onContextEvent?.((event: ContextEvent) => handleContext(event));

	async function handleContext(event: ContextEvent): Promise<ContextEventResult> {
		const messages = event.messages;
		const tokensBefore = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
		const pruned = applyPruning(messages, state, config.protectTurns);
		const tokensAfter = pruned.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

		// Append-only per-pass metric row: the transform's one-time shrink, this request.
		const passSaved = tokensBefore - tokensAfter;
		if (passSaved > 0) {
			adapter.appendMetric({
				kind: "pass",
				ts: Date.now(),
				tokensBefore,
				tokensAfter,
				savedTokens: passSaved,
				activeBlocks: state.compressionBlocks.filter((b) => b.active).length,
			});
		}

		const tokens = event.tokens ?? 0;
		const economics = cacheEconomics(event.modelCost);

		if (!state.manualMode && event.contextWindow && !autoMoltInFlight) {
			const decision = shouldAutoMolt(state, config, economics, tokens, event.contextWindow, event.modelCost);
			if (decision.fire && decision.candidateRanges.length > 0) {
				autoMoltInFlight = true;
				// Off-band (managed async): summarize candidates, push blocks for the next pass.
				void runAutoMolt(decision.candidateRanges.flatMap((r) => r.toolCallIds))
					.catch((error) =>
						adapter.log?.("warn", `molt: auto-molt skipped: ${error instanceof Error ? error.message : String(error)}`),
					)
					.finally(() => {
						autoMoltInFlight = false;
					});
			}
		}

		// Nudges (skipped in manual mode).
		if (!state.manualMode && event.contextWindow && event.contextWindow > 0) {
			const percent = tokens / event.contextWindow;
			let nudge: string | null = null;
			if (percent > config.maxContextPercent) nudge = CONTEXT_STRONG_NUDGE;
			else if (percent > config.maxContextPercent * 0.8) nudge = CONTEXT_SOFT_NUDGE;
			else if (state.currentTurn % 4 === 3) nudge = TURN_NUDGE;
			else if (pruned.filter((m) => m.role === "toolResult").length % 8 === 7) nudge = ITERATION_NUDGE;
			if (nudge) {
				pruned.push({ role: "user", content: nudge, timestamp: Date.now() });
			}
		}

		return { messages: pruned };
	}

	// Summarize candidate ranges, archive originals, push blocks for the next pass.
	async function runAutoMolt(toolCallIds: string[]): Promise<void> {
		if (!summarizer) return;
		const messages = adapter.sessionMessages();
		const idTargets = toolCallIds
			.map((id) => state.toolCalls.get(id))
			.filter((r): r is ToolRecord => r !== undefined && r.timestamp > 0);
		if (idTargets.length === 0) return;
		const ranges = idTargets.map((r) => {
			const msgId = findMessageIdByTimestamp(state, r.timestamp);
			return { startId: msgId, endId: msgId };
		});

		const summary = await summarizeRanges({
			ranges,
			messages,
			state,
			callModel: (input) => summarizer.callModel(config.model, input),
		});

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
		adapter.appendMetric({
			kind: "block",
			ts: Date.now(),
			topic: summary.topic,
			sourceTokens: sourceTotal,
			summaryTokens: summaryTotal,
			savedTokens: Math.max(0, sourceTotal - summaryTotal),
		});
		adapter.log?.("info", `molt: auto-molted ${taggedRanges.length} range(s), archive hash ${hash}`);
	}
}

function findMessageIdByTimestamp(state: MoltState, timestamp: number): string {
	let best: { id: string; ts: number } | undefined;
	for (const [id, ts] of state.messageIdSnapshot) {
		if (ts === timestamp && (!best || ts < best.ts)) best = { id, ts };
	}
	return best?.id ?? "m001";
}
