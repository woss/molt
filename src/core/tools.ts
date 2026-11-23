// molt — model-invoked tools: molt (compress) + molt_expand (archive recall)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { ARCHIVE_DIR, persistOriginal } from "./archive.ts";
import type { CompressionBlock, MoltState } from "./state.ts";
import { collectRangeMessages, estimateRangeSourceTokens, estimateTokens } from "./splicer.ts";
import type { HostAdapter, MoltToolDef } from "../types.ts";

/** Replace (bN) placeholders in a summary with the referenced block's stored content. */
function expandBlockPlaceholders(summary: string, state: MoltState): string {
	return summary.replace(/\(b(\d+)\)/g, (match, idStr: string) => {
		const block = state.compressionBlocks.find((b) => b.id === Number(idStr) && b.active);
		return block ? `[Previously compressed: ${block.topic}]\n${block.summary}` : match;
	});
}

function resolveIdToTimestamp(
	rawId: string,
	field: "startTimestamp" | "endTimestamp",
	state: MoltState,
): number {
	const id = rawId.trim();
	const blockMatch = id.match(/^b(\d+)$/i);
	if (blockMatch) {
		const block = state.compressionBlocks.find((b) => b.id === Number(blockMatch[1]) && b.active);
		if (!block) throw new Error(`Unknown message ID: ${id}`);
		return block[field];
	}
	const ts = state.messageIdSnapshot.get(id);
	if (ts === undefined) throw new Error(`Unknown message ID: ${id}`);
	return ts;
}

/** Anchor: first raw message strictly after the range; end+1 fallback avoids Infinity at tool time. */
function resolveAnchorTimestamp(endTimestamp: number, state: MoltState): number {
	let anchor: number | null = null;
	for (const ts of state.messageIdSnapshot.values()) {
		if (ts > endTimestamp && (anchor === null || ts < anchor)) anchor = ts;
	}
	return anchor ?? endTimestamp + 1;
}

export interface CreateBlocksResult {
	blockIds: number[];
	expandedSummaries: string[];
}

/** Shared range→block logic for the molt tool and the scheduler path. */
export function createBlocks(
	topic: string,
	ranges: Array<{ startId: string; endId: string; summary: string }>,
	state: MoltState,
	sourceTokens?: number[],
): CreateBlocksResult {
	const blockIds: number[] = [];
	const expandedSummaries: string[] = [];

	for (const [i, range] of ranges.entries()) {
		const startTimestamp = resolveIdToTimestamp(range.startId, "startTimestamp", state);
		const endTimestamp = resolveIdToTimestamp(range.endId, "endTimestamp", state);
		if (startTimestamp > endTimestamp) {
			throw new Error(`Range start "${range.startId}" must appear before end "${range.endId}"`);
		}
		if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
			throw new Error(`Range "${range.startId}..${range.endId}" resolved to a non-finite timestamp`);
		}

		for (const existing of state.compressionBlocks) {
			if (!existing.active) continue;
			if (!Number.isFinite(existing.startTimestamp) || !Number.isFinite(existing.endTimestamp)) continue;
			if (startTimestamp <= existing.endTimestamp && existing.startTimestamp <= endTimestamp) {
				// The model can't see bN spans in its context; name them so it can retry with a corrected range.
				const spanId = (ts: number) => {
					for (const [id, t] of state.messageIdSnapshot) if (t === ts) return id;
					return String(ts);
				};
				throw new Error(
					`Overlapping ranges not supported: ${range.startId}..${range.endId} overlaps block b${existing.id} (${spanId(existing.startTimestamp)}..${spanId(existing.endTimestamp)}). Use a range outside it.`,
				);
			}
		}

		const anchorTimestamp = resolveAnchorTimestamp(endTimestamp, state);
		const expandedSummary = expandBlockPlaceholders(range.summary, state);
		const block: CompressionBlock = {
			id: state.nextBlockId++,
			topic,
			summary: expandedSummary,
			startTimestamp,
			endTimestamp,
			anchorTimestamp,
			active: true,
			sourceTokens: Math.max(0, sourceTokens?.[i] ?? 0),
			summaryTokenEstimate: estimateTokens(expandedSummary),
			createdAt: Date.now(),
		};
		state.compressionBlocks.push(block);
		blockIds.push(block.id);
		expandedSummaries.push(expandedSummary);
	}

	return { blockIds, expandedSummaries };
}

export function createTools(host: HostAdapter, state: MoltState): MoltToolDef[] {
	const moltTool: MoltToolDef = {
		name: "molt",
		label: "Molt Context",
		description:
			"Compress ranges of conversation into dense technical summaries to manage context. " +
			"Use only <molt-id> boundary IDs visible in context (mNNN for messages, bN for previously molted blocks). " +
			"startId must appear before endId. Batch independent ranges in one call.",
		parameters: Type.Object({
			topic: Type.String({ description: "Short label (3-5 words), e.g. 'Auth Exploration'" }),
			ranges: Type.Array(
				Type.Object({
					startId: Type.String({ description: "Message ID marking range start (m001, b2)" }),
					endId: Type.String({ description: "Message ID marking range end (m042, b5)" }),
					summary: Type.String({
						description: "Exhaustive technical summary replacing all content in range",
					}),
				}),
				{ description: "One or more ranges to molt" },
			),
		}),
		async execute(_toolCallId, params) {
			const { topic, ranges: requested } = params as { topic: string; ranges: Array<{ startId: string; endId: string; summary: string }> };
			// Archive originals + embed the recall marker, same contract as runAutoMolt.
			const messages = host.sessionMessages();
			const originals = collectRangeMessages(messages, state, requested);
			const hash = originals.length > 0 ? await persistOriginal(originals) : null;
			const ranges = hash
				? requested.map((r) => ({ ...r, summary: `${r.summary}\n\nExpand originals: molt_expand hash=${hash}` }))
				: requested;
			const sourceTokens = estimateRangeSourceTokens(messages, state, requested);
			const { blockIds, expandedSummaries } = createBlocks(topic, ranges, state, sourceTokens);
			const sourceTotal = sourceTokens.reduce((a, b) => a + b, 0);
			const summaryTotal = expandedSummaries.reduce((a, s) => a + estimateTokens(s), 0);
			host.appendMetric({
				kind: "block",
				ts: Date.now(),
				blockIds,
				topic,
				sourceTokens: sourceTotal,
				summaryTokens: summaryTotal,
				savedTokens: Math.max(0, sourceTotal - summaryTotal),
			});
			host.notify?.(`Molted: ${topic} (${requested.length} range(s))`, "info");
			return {
				content: [{ type: "text", text: `Molted ${requested.length} range(s): ${topic}` }],
				details: { blockIds, topic, archiveHash: hash },
			};
		},
	};

	const expandTool: MoltToolDef = {
		name: "molt_expand",
		label: "Expand Molted Originals",
		description:
			"Retrieve the full original messages of a molted section by hash. " +
			'Use the hash from "Expand originals: molt_expand hash=<hash>" markers in molted summaries.',
		parameters: Type.Object({
			hash: Type.String({ description: "24-char archive hash" }),
		}),
		async execute(_toolCallId, params) {
			const { hash } = params as { hash: string };
			try {
				const original = await readFile(join(ARCHIVE_DIR, `${hash}.json`), "utf8");
				return { content: [{ type: "text", text: original }] };
			} catch {
				return {
					content: [{ type: "text", text: `molt_expand: no archived original for hash ${hash}` }],
					isError: true,
				};
			}
		},
	};

	return [moltTool, expandTool];
}
