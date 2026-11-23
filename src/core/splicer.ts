// molt — context transform, ported from pi-dcp pruner.ts (molt naming).

import type { MoltState } from "./state.ts";

const MOLT_PROTECTED_DEDUP = new Set(["molt", "molt_expand", "write", "edit"]);
const ID_ELIGIBLE_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);
const PASSTHROUGH_ROLES = new Set(["compaction", "branch_summary", "custom_message"]);
const MOLT_ID_TAG_RE = /\s*<molt-id>m\d+<\/molt-id>/g;

export function estimateTokens(text: string): number {
	return Math.round(text.length / 4);
}

/** Raw messages whose timestamps fall within any range, per the id→timestamp snapshot. */
export function collectRangeMessages(
	messages: AnyMsg[],
	state: MoltState,
	ranges: Array<{ startId: string; endId: string }>,
): AnyMsg[] {
	const startTs = Math.min(
		...ranges.map((r) => state.messageIdSnapshot.get(r.startId.trim()) ?? Number.POSITIVE_INFINITY),
	);
	const endTs = Math.max(...ranges.map((r) => state.messageIdSnapshot.get(r.endId.trim()) ?? 0));
	return messages.filter((m) => {
		const ts = m.timestamp ?? 0;
		return ts >= startTs && ts <= endTs;
	});
}

/** Per-range estimated source tokens: raw messages inside each range interval, per the id→ts snapshot. */
export function estimateRangeSourceTokens(
	messages: AnyMsg[],
	state: MoltState,
	ranges: Array<{ startId: string; endId: string }>,
): number[] {
	return ranges.map((r) => {
		const startTs = state.messageIdSnapshot.get(r.startId.trim()) ?? Number.POSITIVE_INFINITY;
		const endTs = state.messageIdSnapshot.get(r.endId.trim()) ?? 0;
		let total = 0;
		for (const m of messages) {
			const ts = m.timestamp ?? 0;
			if (ts >= startTs && ts <= endTs) total += estimateMessageTokens(m);
		}
		return total;
	});
}

type AnyMsg = Record<string, any>; // omp message shapes are provider-union; structural access only

export function estimateMessageTokens(msg: AnyMsg | undefined | null): number {
	if (!msg) return 0;
	const content = msg.content;
	if (!content) return 0;
	if (typeof content === "string") return estimateTokens(content);
	if (Array.isArray(content)) {
		let total = 0;
		for (const part of content) {
			if (part && typeof part === "object") {
				if (typeof part.text === "string") total += estimateTokens(part.text);
				else if (typeof part.thinking === "string") total += estimateTokens(part.thinking);
				else if (part.type === "image") total += 500;
			}
		}
		return total;
	}
	return 0;
}

/** Apply active compression blocks: splice ranges atomically, insert synthetic summaries. */
function applyCompressionBlocks(messages: AnyMsg[], state: MoltState): AnyMsg[] {
	const activeBlocks = state.compressionBlocks.filter((b) => b.active);
	for (const block of activeBlocks) {
		if (!Number.isFinite(block.startTimestamp) || !Number.isFinite(block.endTimestamp)) continue;

		const startIdx = messages.findIndex((m) => m.timestamp === block.startTimestamp);
		const endIdx = messages.findIndex((m) => m.timestamp === block.endTimestamp);
		if (startIdx === -1 || endIdx === -1) continue;

		let lo = Math.min(startIdx, endIdx);
		let hi = Math.max(startIdx, endIdx);

		// Expand lo backward: pull the owning assistant (and intermediate results)
		// into the range so assistant↔toolResult groups stay atomic.
		while (lo > 0) {
			let scanIdx = lo - 1;
			while (scanIdx >= 0) {
				const r = messages[scanIdx]!.role as string;
				if (r !== "toolResult" && r !== "bashExecution" && !PASSTHROUGH_ROLES.has(r)) break;
				scanIdx--;
			}
			if (scanIdx < 0 || messages[scanIdx]!.role !== "assistant") break;

			const prev = messages[scanIdx]!;
			const toolCallIdsInRange = new Set<string>();
			for (let i = lo; i <= hi; i++) {
				const m = messages[i]!;
				if ((m.role === "toolResult" || m.role === "bashExecution") && typeof m.toolCallId === "string") {
					toolCallIdsInRange.add(m.toolCallId);
				}
			}
			const prevContent: any[] = Array.isArray(prev.content) ? prev.content : [];
			const hasMatchingToolCalls = prevContent.some((b) => b.type === "toolCall" && toolCallIdsInRange.has(b.id));
			if (!hasMatchingToolCalls) break;
			lo = scanIdx;
		}

		// Expand hi forward: include toolResults owned by assistants in the range.
		let prevHi: number;
		do {
			prevHi = hi;
			const assistantToolCallIds = new Set<string>();
			for (let i = lo; i <= hi; i++) {
				const m = messages[i]!;
				if (m.role !== "assistant") continue;
				const content: any[] = Array.isArray(m.content) ? m.content : [];
				for (const b of content) {
					if (b.type === "toolCall" && typeof b.id === "string") assistantToolCallIds.add(b.id);
				}
			}
			while (hi + 1 < messages.length) {
				const next = messages[hi + 1]!;
				if (
					(next.role === "toolResult" || next.role === "bashExecution") &&
					assistantToolCallIds.has(next.toolCallId)
				) {
					hi++;
				} else if (PASSTHROUGH_ROLES.has(next.role)) {
					hi++;
				} else {
					break;
				}
			}
		} while (hi !== prevHi);

		let removedTokens = 0;
		for (let i = lo; i <= hi; i++) removedTokens += estimateMessageTokens(messages[i]);

		messages.splice(lo, hi - lo + 1);

		const syntheticMsg: AnyMsg = {
			role: "user",
			content: [
				{
					type: "text",
					text: `[Molted section: ${block.topic}]\n\n${block.summary}\n\n<molt-block-id>b${block.id}</molt-block-id>`,
				},
			],
			timestamp: Number.isFinite(block.anchorTimestamp) ? block.anchorTimestamp - 0.5 : block.endTimestamp + 0.5,
		};

		const addedTokens = estimateMessageTokens(syntheticMsg);
		messages.push(syntheticMsg);
		messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

		const saved = removedTokens - addedTokens;
		if (saved > 0) state.tokensSaved += saved;
	}
	return messages;
}

/** Drop toolResults without a matching assistant toolCall; strip orphaned toolCall blocks. */
export function repairOrphanedToolPairs(messages: AnyMsg[]): void {
	const assistantToolCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const content: any[] = Array.isArray(msg.content) ? msg.content : [];
		for (const b of content) {
			if (b.type === "toolCall" && typeof b.id === "string") assistantToolCallIds.add(b.id);
		}
	}

	const resultToolCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
		if (typeof msg.toolCallId === "string") resultToolCallIds.add(msg.toolCallId);
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
		if (typeof msg.toolCallId === "string" && !assistantToolCallIds.has(msg.toolCallId)) {
			messages.splice(i, 1);
		}
	}

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const content: any[] = Array.isArray(msg.content) ? msg.content : [];
		if (!content.some((b) => b.type === "toolCall")) continue;
		const filtered = content.filter((b) => {
			if (b.type !== "toolCall") return true;
			return typeof b.id === "string" && resultToolCallIds.has(b.id);
		});
		if (filtered.length !== content.length) {
			msg.content = filtered.length > 0 ? filtered : [];
		}
	}
}

/** Replace all-but-last duplicate tool outputs (same input fingerprint) in place. */
function applyDeduplication(messages: AnyMsg[], state: MoltState): void {
	const fingerprintMap = new Map<string, string[]>();
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		const toolName: string = msg.toolName ?? "";
		if (MOLT_PROTECTED_DEDUP.has(toolName)) continue;
		const record = state.toolCalls.get(msg.toolCallId);
		if (!record) continue;
		const ids = fingerprintMap.get(record.inputFingerprint) ?? [];
		ids.push(msg.toolCallId);
		fingerprintMap.set(record.inputFingerprint, ids);
	}
	for (const ids of fingerprintMap.values()) {
		for (let i = 0; i < ids.length - 1; i++) state.prunedToolIds.add(ids[i]!);
	}
}

/** Mark old error outputs for pruning. */
function applyErrorPurging(messages: AnyMsg[], state: MoltState, protectTurns: number): void {
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		if (!msg.isError) continue;
		const record = state.toolCalls.get(msg.toolCallId);
		if (!record) continue;
		if (state.currentTurn - record.turnIndex >= protectTurns) state.prunedToolIds.add(msg.toolCallId);
	}
}

/** Replace pruned tool outputs in place, structure preserved. */
function applyToolOutputPruning(messages: AnyMsg[], state: MoltState): void {
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		if (!state.prunedToolIds.has(msg.toolCallId)) continue;
		msg.content = [
			{
				type: "text",
				text: msg.isError ? "[Error output removed]" : "[Output removed — duplicate of a later identical call]",
			},
		];
	}
}

function stripExistingMessageIds(msg: AnyMsg): void {
	if (typeof msg.content === "string") {
		msg.content = msg.content.replace(MOLT_ID_TAG_RE, "").trimEnd();
		return;
	}
	if (!Array.isArray(msg.content)) return;
	const content: any[] = [];
	for (const block of msg.content) {
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
			const text = block.text.replace(MOLT_ID_TAG_RE, "").trimEnd();
			if (text.length === 0) continue;
			content.push(text === block.text ? block : { ...block, text });
			continue;
		}
		content.push(block);
	}
	msg.content = content;
}

/** Inject sequential mNNN ids; idempotent (strip first). */
function injectMessageIds(messages: AnyMsg[], state: MoltState): void {
	state.messageIdSnapshot.clear();
	let counter = 1;
	for (const msg of messages) {
		const role: string = msg.role ?? "";
		if (PASSTHROUGH_ROLES.has(role)) continue;
		if (!ID_ELIGIBLE_ROLES.has(role)) continue;

		stripExistingMessageIds(msg);
		const id = `m${String(counter).padStart(3, "0")}`;
		counter++;
		const idTag = `\n<molt-id>${id}</molt-id>`;

		if (role === "user") {
			if (typeof msg.content === "string") {
				msg.content = msg.content + `\n\n<molt-id>${id}</molt-id>`;
			} else if (Array.isArray(msg.content)) {
				msg.content = [...msg.content, { type: "text", text: idTag }];
			}
		} else if (role === "toolResult" || role === "bashExecution") {
			if (Array.isArray(msg.content)) {
				msg.content = [...msg.content, { type: "text", text: idTag }];
			} else if (typeof msg.content === "string") {
				msg.content = msg.content + idTag;
			}
		} else if (role === "assistant") {
			if (Array.isArray(msg.content)) {
				// Anthropic ordering: thinking → text → toolCall. Insert before the first toolCall.
				const firstToolCallIdx = msg.content.findIndex((b: any) => b.type === "toolCall");
				const idBlock = { type: "text", text: idTag };
				if (firstToolCallIdx === -1) {
					msg.content = [...msg.content, idBlock];
				} else {
					msg.content = [...msg.content.slice(0, firstToolCallIdx), idBlock, ...msg.content.slice(firstToolCallIdx)];
				}
			} else if (typeof msg.content === "string") {
				msg.content = msg.content + idTag;
			}
		}

		if (msg.timestamp !== undefined) state.messageIdSnapshot.set(id, msg.timestamp);
	}
}

/** Main transform: clone → turn count → blocks → orphan repair → dedup → error purge → ids. */
export function applyPruning(messages: AnyMsg[], state: MoltState, protectTurns: number): AnyMsg[] {
	const msgs: AnyMsg[] = messages.map((m) => {
		const clone: AnyMsg = { ...m };
		if (Array.isArray(clone.content)) {
			clone.content = clone.content.map((b) => (typeof b === "object" && b !== null ? { ...b } : b));
		}
		return clone;
	});

	state.currentTurn = msgs.filter((m) => m.role === "user").length;

	applyCompressionBlocks(msgs, state);
	repairOrphanedToolPairs(msgs);
	applyDeduplication(msgs, state);
	applyErrorPurging(msgs, state, protectTurns);
	applyToolOutputPruning(msgs, state);
	injectMessageIds(msgs, state);

	return msgs;
}
