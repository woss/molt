// molt — LLM summary of stale ranges: prompt building, repair retry, validation.
// The actual model call is injected (Summarizer boundary in ../types.ts).

import type { MoltState } from "./state.ts";

type AnyMsg = Record<string, any>;

export interface SummaryRange {
	startId: string;
	endId: string;
	summary: string;
}

export interface SummarizeResult {
	topic: string;
	ranges: SummaryRange[];
}

function extractJson(text: string): SummarizeResult {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("molt: summarizer output is not JSON");
	const parsed = JSON.parse(text.slice(start, end + 1)) as {
		topic?: unknown;
		ranges?: Array<{ startId?: unknown; endId?: unknown; summary?: unknown }>;
	};
	if (typeof parsed.topic !== "string" || !Array.isArray(parsed.ranges)) {
		throw new Error("molt: summarizer JSON missing topic/ranges");
	}
	const ranges = parsed.ranges.map((r) => ({
		startId: String(r.startId ?? ""),
		endId: String(r.endId ?? ""),
		summary: String(r.summary ?? ""),
	}));
	if (ranges.length === 0) throw new Error("molt: summarizer returned zero ranges");
	return { topic: parsed.topic, ranges };
}

/** Summarize stale ranges with the configured model; one repair retry, then throw. */
export async function summarizeRanges(opts: {
	ranges: Array<{ startId: string; endId: string }>;
	messages: AnyMsg[];
	state: MoltState;
	callModel: (input: string) => Promise<string>;
}): Promise<SummarizeResult> {
	const { ranges, messages, state, callModel } = opts;

	const rangeText = ranges.map((r) => `${r.startId}..${r.endId}`).join(", ");
	const relevant = messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
	const input = `Compress the conversation ranges: ${rangeText}. Reply with the JSON object only.`;
	const fullInput = `${input}\n\n<conversation>\n${JSON.stringify(relevant).slice(0, 200_000)}\n</conversation>`;

	let text: string;
	try {
		text = await callModel(fullInput);
	} catch (firstError) {
		// Repair retry: show the model its rejected output + reason.
		try {
			const repairInput = `${fullInput}\n\nYour previous reply was rejected: ${String(firstError).slice(0, 300)}. Reply with the corrected JSON object only.`;
			text = await callModel(repairInput);
		} catch {
			throw firstError;
		}
	}

	const result = extractJson(text);
	// Every range id must resolve via the same id→timestamp logic as the molt tool.
	for (const r of result.ranges) {
		for (const id of [r.startId, r.endId]) {
			const trimmed = id.trim();
			const blockMatch = trimmed.match(/^b(\d+)$/i);
			if (blockMatch) {
				const blockId = Number(blockMatch[1]);
				if (!state.compressionBlocks.some((b) => b.id === blockId && b.active)) {
					throw new Error(`molt: summarizer referenced unknown block id ${id}`);
				}
				continue;
			}
			if (!state.messageIdSnapshot.has(trimmed)) {
				throw new Error(`molt: summarizer referenced unknown message id ${id}`);
			}
		}
	}
	// Reject overlapping ranges.
	const resolved = result.ranges.map((r) => ({
		start: state.messageIdSnapshot.get(r.startId.trim()) ?? 0,
		end: state.messageIdSnapshot.get(r.endId.trim()) ?? 0,
	}));
	for (let i = 0; i < resolved.length; i++) {
		for (let j = i + 1; j < resolved.length; j++) {
			if (resolved[i]!.start <= resolved[j]!.end && resolved[j]!.start <= resolved[i]!.end) {
				throw new Error("molt: summarizer returned overlapping ranges");
			}
		}
	}
	return result;
}
