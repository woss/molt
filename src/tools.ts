// molt — model-invoked tools: molt (compress) + molt_expand (archive recall)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ARCHIVE_DIR, persistOriginal } from "./archive.ts";
import type { CompressionBlock, MoltState } from "./state.ts";
import { collectRangeMessages, estimateRangeSourceTokens, estimateTokens } from "./splicer.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Replace (bN) placeholders in a summary with the referenced block's stored content. */
function expandBlockPlaceholders(summary: string, state: MoltState): string {
	return summary.replace(/\(b(\d+)\)/g, (match, idStr: string) => {
		const block = state.compressionBlocks.find((b) => b.id === Number(idStr) && b.active);
		return block ? `[Previously compressed: ${block.topic}]\n${block.summary}` : match;
	});
}

function resolveIdToTimestamp(rawId: string, field: "startTimestamp" | "endTimestamp", state: MoltState): number {
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

export function registerTools(pi: ExtensionAPI, state: MoltState): void {
	// registerTool<TParams extends TSchema> instantiates the typebox shim's
	// arktype-derived schema types infinitely deep; the runtime is duck-typed.
	const register = pi.registerTool.bind(pi) as (tool: unknown) => void;

	register({
		name: "molt",
		label: "Molt Context",
		description:
			"Compress ranges of conversation into dense technical summaries to manage context. " +
			"Use only <molt-id> boundary IDs visible in context (mNNN for messages, bN for previously molted blocks). " +
			"startId must appear before endId. Batch independent ranges in one call.",
		parameters: pi.typebox.Type.Object({
			topic: pi.typebox.Type.String({ description: "Short label (3-5 words), e.g. 'Auth Exploration'" }),
			ranges: pi.typebox.Type.Array(
				pi.typebox.Type.Object({
					startId: pi.typebox.Type.String({ description: "Message ID marking range start (m001, b2)" }),
					endId: pi.typebox.Type.String({ description: "Message ID marking range end (m042, b5)" }),
					summary: pi.typebox.Type.String({
						description: "Exhaustive technical summary replacing all content in range",
					}),
				}),
				{ description: "One or more ranges to molt" },
			),
		}),
		async execute(
			_toolCallId,
			params: { topic: string; ranges: Array<{ startId: string; endId: string; summary: string }> },
			_signal,
			_onUpdate,
			ctx,
		) {
			// Archive originals + embed the recall marker, same contract as runAutoMolt.
			const messages =
				ctx?.sessionManager
					?.getBranch?.()
					.filter((e: any) => e.messages)
					.flatMap((e: any) => e.messages) ?? [];
			const originals = collectRangeMessages(messages as any[], state, params.ranges);
			const hash = originals.length > 0 ? await persistOriginal(originals) : null;
			const ranges = hash
				? params.ranges.map((r) => ({ ...r, summary: `${r.summary}\n\nExpand originals: molt_expand hash=${hash}` }))
				: params.ranges;
			const sourceTokens = estimateRangeSourceTokens(messages as any[], state, params.ranges);
			const { blockIds, expandedSummaries } = createBlocks(params.topic, ranges, state, sourceTokens);
			const sourceTotal = sourceTokens.reduce((a, b) => a + b, 0);
			const summaryTotal = expandedSummaries.reduce((a, s) => a + estimateTokens(s), 0);
			pi.appendEntry("molt-metric", {
				kind: "block",
				ts: Date.now(),
				blockIds,
				topic: params.topic,
				sourceTokens: sourceTotal,
				summaryTokens: summaryTotal,
				savedTokens: Math.max(0, sourceTotal - summaryTotal),
			});
			ctx.ui.notify(`Molted: ${params.topic} (${params.ranges.length} range(s))`, "info");
			return {
				content: [{ type: "text", text: `Molted ${params.ranges.length} range(s): ${params.topic}` }],
				details: { blockIds, topic: params.topic, archiveHash: hash },
			};
		},
	});

	register({
		name: "molt_expand",
		label: "Expand Molted Originals",
		description:
			"Retrieve the full original messages of a molted section by hash. " +
			'Use the hash from "Expand originals: molt_expand hash=<hash>" markers in molted summaries.',
		parameters: pi.typebox.Type.Object({
			hash: pi.typebox.Type.String({ description: "24-char archive hash" }),
		}),
		async execute(_toolCallId, params: { hash: string }) {
			try {
				const original = await readFile(join(ARCHIVE_DIR, `${params.hash}.json`), "utf8");
				return { content: [{ type: "text", text: original }] };
			} catch {
				return {
					content: [{ type: "text", text: `molt_expand: no archived original for hash ${params.hash}` }],
					isError: true,
				};
			}
		},
	});
}
