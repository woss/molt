import { describe, expect, it } from "vitest";
import {
	createState,
	deserializeMoltState,
	serializeMoltState,
	createInputFingerprint,
	type MoltState,
} from "../src/state.ts";
import { createBlocks } from "../src/tools.ts";
import { recordUsage, cacheEconomics, projectBustCostUsd } from "../src/telemetry.ts";
import { shouldAutoMolt, DEFAULT_CONFIG, type MoltConfig } from "../src/scheduler.ts";
import { applyPruning, estimateRangeSourceTokens, repairOrphanedToolPairs } from "../src/splicer.ts";

let ts = 1000;
function userMsg(text: string): Record<string, any> {
	return { role: "user", content: text, timestamp: ts++ };
}
function assistantWithToolCall(id: string, text = "calling"): Record<string, any> {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id, name: "read" },
		],
		timestamp: ts++,
	};
}
function toolResult(toolCallId: string, text: string, isError = false): Record<string, any> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: ts++,
	};
}

function record(
	state: MoltState,
	toolCallId: string,
	turnIndex: number,
	tokenEstimate: number,
	toolName = "read",
	isError = false,
): void {
	state.toolCalls.set(toolCallId, {
		toolCallId,
		toolName,
		inputArgs: {},
		inputFingerprint: createInputFingerprint(toolName, {}),
		isError,
		turnIndex,
		timestamp: 1,
		tokenEstimate,
	});
}

describe("splicer", () => {
	it("splices an assistant toolCall + its toolResult as one unit", () => {
		const state = createState();
		state.compressionBlocks.push({
			id: 1,
			topic: "t",
			summary: "summary",
			startTimestamp: 1000,
			endTimestamp: 1002,
			anchorTimestamp: Infinity,
			active: true,
			sourceTokens: 0,
			summaryTokenEstimate: 4,
			createdAt: 1,
		});
		const messages = [userMsg("go"), assistantWithToolCall("tc1"), toolResult("tc1", "output"), userMsg("next")];
		const out = applyPruning(messages, state, 2);
		// The whole group must vanish; a synthetic summary message replaces it.
		const text = JSON.stringify(out);
		expect(text).not.toContain('"calling"');
		expect(text).not.toContain('"output"');
		expect(text).toContain("Molted section: t");
	});

	it("removes a hand-built orphaned toolResult in the repair pass", () => {
		const messages = [userMsg("u"), toolResult("orphan", "ghost output")];
		repairOrphanedToolPairs(messages);
		expect(messages.filter((m) => m.role === "toolResult")).toHaveLength(0);
	});

	it("strips orphaned toolCall blocks from assistants", () => {
		const messages = [assistantWithToolCall("tc1")];
		repairOrphanedToolPairs(messages);
		const content = messages[0]!.content as any[];
		expect(content.filter((b) => b.type === "toolCall")).toHaveLength(0);
	});

	it("id injection is idempotent across two passes", () => {
		const state = createState();
		const messages = [userMsg("a"), assistantWithToolCall("t1"), toolResult("t1", "x"), userMsg("b")];
		const one = applyPruning(messages, state, 2);
		const snapshot = state.messageIdSnapshot.size;
		const two = applyPruning(one, state, 2);
		expect(state.messageIdSnapshot.size).toBe(snapshot);
		const text = JSON.stringify(two);
		expect(text.match(/<molt-id>m001<\/molt-id>/g)).toHaveLength(1);
	});

	it("dedups repeated identical tool outputs keeping the last", () => {
		const state = createState();
		record(state, "t1", 0, 10, "read");
		record(state, "t2", 1, 10, "read");
		const messages = [
			assistantWithToolCall("t1"),
			toolResult("t1", "same output"),
			assistantWithToolCall("t2"),
			toolResult("t2", "same output"),
		];
		const out = applyPruning(messages, state, 2);
		const results = out.filter((m) => m.role === "toolResult");
		expect((results[0]!.content as any[])[0]!.text).toContain("duplicate of a later identical call");
		expect((results[1]!.content as any[])[0]!.text).toBe("same output");
	});

	it("purges old error outputs after protectTurns", () => {
		const state = createState();
		state.currentTurn = 5;
		record(state, "t1", 0, 10, "bash", true);
		record(state, "t2", 5, 10, "bash", true);
		const messages = [
			assistantWithToolCall("t1"),
			toolResult("t1", "boom", true),
			assistantWithToolCall("t2"),
			toolResult("t2", "fresh boom", true),
		];
		const out = applyPruning(messages, state, 2);
		const results = out.filter((m) => m.role === "toolResult");
		expect((results[0]!.content as any[])[0]!.text).toContain("[Error output removed]");
		expect((results[1]!.content as any[])[0]!.text).toBe("fresh boom");
	});
});

describe("state round-trip", () => {
	it("preserves blocks incl. anchorTimestamp Infinity", () => {
		const state = createState();
		state.compressionBlocks.push({
			id: 1,
			topic: "t",
			summary: "s",
			startTimestamp: 1,
			endTimestamp: 2,
			anchorTimestamp: Infinity,
			active: true,
			sourceTokens: 40,
			summaryTokenEstimate: 3,
			createdAt: 4,
		});
		const json = JSON.parse(JSON.stringify(serializeMoltState(state)));
		const restored = deserializeMoltState(json)!;
		expect(restored.compressionBlocks![0]!.anchorTimestamp).toBe(2.5);
		expect(restored.compressionBlocks![0]!.id).toBe(1);
	});
});

describe("telemetry", () => {
	it("sums realSpendUsd to the penny of cost.total", () => {
		const state = createState();
		recordUsage(state, { input: 100, cacheRead: 50, cacheWrite: 10, cost: { total: 0.0101 } });
		recordUsage(state, { input: 200, cacheRead: 0, cacheWrite: 5, cost: { total: 0.0299 } });
		recordUsage(state, { input: 1, cost: { total: 0.0001 } });
		expect(state.realSpendUsd).toBeCloseTo(0.0401, 10);
		expect(state.cacheReadTokens).toBe(50);
	});

	it("clamps negative usage to 0", () => {
		const state = createState();
		recordUsage(state, { input: -5, cacheRead: -1, cost: { total: -1 } });
		expect(state.realSpendUsd).toBe(0);
		expect(state.inputTokens).toBe(0);
	});

	it("cacheEconomics falls back to zero rates when cost is missing", () => {
		expect(cacheEconomics(undefined)).toEqual({ readRate: 0, writeRate: 0 });
		expect(cacheEconomics({ cost: { cacheRead: 0.0000005, cacheWrite: 0.00000375 } })).toEqual({
			readRate: 0.0000005,
			writeRate: 0.00000375,
		});
		expect(projectBustCostUsd(200_000, { readRate: 0.0000005, writeRate: 0.00000375 })).toBeCloseTo(0.65, 6);
	});
});

describe("scheduler", () => {
	const base: MoltConfig = { ...DEFAULT_CONFIG };

	function firingState(candidateTokens: number, currentTurn = 10): MoltState {
		const state = createState();
		state.currentTurn = currentTurn;
		record(state, "t1", 0, candidateTokens, "bash");
		return state;
	}

	it("fires on the decision-table case: 200k context, 30k candidates, real rates", () => {
		const econ = { readRate: 0.0000005, writeRate: 0.00000375 };
		const d = shouldAutoMolt(firingState(30_000), base, econ, 200_000, 200_000, {
			cost: { input: 0.000001, output: 0.000003 },
		});
		expect(d.fire).toBe(true);
		expect(d.candidateRanges.length).toBeGreaterThan(0);
	});

	it("does not fire with zero cache rates and 5k candidates", () => {
		const econ = { readRate: 0, writeRate: 0 };
		const d = shouldAutoMolt(firingState(5_000), base, econ, 200_000, 400_000, undefined);
		expect(d.fire).toBe(false);
	});

	it("does not fire below maxContextPercent", () => {
		const econ = { readRate: 0.0000005, writeRate: 0.00000375 };
		const d = shouldAutoMolt(firingState(30_000), base, econ, 100_000, 400_000, undefined);
		expect(d.fire).toBe(false);
	});

	it("does not fire in manual mode", () => {
		const state = firingState(30_000);
		state.manualMode = true;
		const d = shouldAutoMolt(state, base, { readRate: 0.001, writeRate: 0.001 }, 200_000, 400_000, undefined);
		expect(d.fire).toBe(false);
	});

	it("does not fire when savings gate is negative despite high usage", () => {
		// Tiny read rate + huge summarizer cost estimate → negative savings.
		const econ = { readRate: 0.00000001, writeRate: 0.00000375 };
		const d = shouldAutoMolt(firingState(30_000), base, econ, 200_000, 400_000, {
			cost: { input: 0.01, output: 0.03 },
		});
		expect(d.fire).toBe(false);
	});
});

describe("metrics", () => {
	it("round-trips block sourceTokens through serialize/deserialize", () => {
		const state = createState();
		state.compressionBlocks.push({
			id: 1,
			topic: "t",
			summary: "s",
			startTimestamp: 1,
			endTimestamp: 2,
			anchorTimestamp: Infinity,
			active: true,
			sourceTokens: 40,
			summaryTokenEstimate: 3,
			createdAt: 4,
		});
		const json = JSON.parse(JSON.stringify(serializeMoltState(state)));
		const restored = deserializeMoltState(json)!;
		expect(restored.compressionBlocks?.[0]?.sourceTokens).toBe(40);
		// Missing field (pre-metering entries) repairs to 0, never negative.
		const legacy = { ...json, blocks: [{ ...json.blocks[0]!, sourceTokens: undefined }] };
		const repaired = deserializeMoltState(legacy)!;
		expect(repaired.compressionBlocks?.[0]?.sourceTokens).toBe(0);
	});

	it("estimates per-range source tokens from the id snapshot", () => {
		const state = createState();
		const messages = [
			userMsg("first user turn"),
			assistantWithToolCall("t1"),
			toolResult("t1", "x"),
			userMsg("final turn"),
		];
		// applyPruning clones; the input keeps its timestamps, staying aligned
		// with the m001-m004 snapshot it just populated.
		applyPruning(messages, state, 2);
		expect(state.messageIdSnapshot.size).toBe(4);
		const totals = estimateRangeSourceTokens(messages, state, [
			{ startId: "m001", endId: "m003" },
			{ startId: "m004", endId: "m004" },
		]);
		expect(totals[0]).toBeGreaterThan(totals[1]!);
		expect(totals[1]).toBeGreaterThan(0);
		// Unknown ids mirror collectRangeMessages: empty interval → zero tokens.
		const unknown = estimateRangeSourceTokens(messages, state, [{ startId: "m999", endId: "m999" }]);
		expect(unknown[0]).toBe(0);
	});
});

describe("createBlocks overlap", () => {
	it("names the conflicting block's span in the overlap error", () => {
		const state = createState();
		state.messageIdSnapshot.set("m001", 1000);
		state.messageIdSnapshot.set("m003", 1002);
		state.messageIdSnapshot.set("m005", 1004);
		state.messageIdSnapshot.set("m009", 1008);
		state.compressionBlocks.push({
			id: 20,
			topic: "prior",
			summary: "summary",
			startTimestamp: 1000,
			endTimestamp: 1004,
			anchorTimestamp: Infinity,
			active: true,
			sourceTokens: 0,
			summaryTokenEstimate: 4,
			createdAt: 1,
		});
		expect(() => createBlocks("next", [{ startId: "m003", endId: "m009", summary: "s" }], state)).toThrow(
			/overlaps block b20 \(m001\.\.m005\)/,
		);
	});
});
