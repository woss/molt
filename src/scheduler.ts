// molt — cache-cost policy: fire automatic summarization only when projected
// savings beat the one-time prompt-cache bust. The only policy in the codebase.

import { readFileSync } from "node:fs";
import { projectBustCostUsd, type CacheEconomics } from "./telemetry.ts";
import type { MoltState } from "./state.ts";

export interface MoltConfig {
	maxContextPercent: number;
	protectTurns: number;
	maxRangeTokens: number;
	auto: boolean;
	model: string;
}

export const DEFAULT_CONFIG: MoltConfig = {
	maxContextPercent: 0.7,
	protectTurns: 2,
	maxRangeTokens: 20_000,
	auto: true,
	model: "@smol",
};

const PROTECTED_TOOLS = new Set(["molt_expand", "molt", "write", "edit"]);

export interface Range {
	toolCallIds: string[];
	tokenEstimate: number;
}

export function estimateTokens(text: string): number {
	return Math.round(text.length / 4);
}

export function loadConfig(cwd: string): MoltConfig {
	try {
		const raw = readFileSync(`${cwd}/.omp/molt.json`, "utf8");
		const overrides = JSON.parse(raw) as Partial<MoltConfig>;
		return deepMerge(DEFAULT_CONFIG, overrides);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function deepMerge(base: MoltConfig, overrides: Partial<MoltConfig>): MoltConfig {
	const merged = { ...base };
	for (const key of Object.keys(base) as Array<keyof MoltConfig>) {
		const value = overrides[key];
		if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
	}
	return merged;
}

export interface ShouldAutoMoltResult {
	fire: boolean;
	candidateRanges: Range[];
	economics: CacheEconomics;
	candidateTokens: number;
	projectSavingsUsd: number;
}

export interface SchedulerModelCost {
	cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
}

/**
 * Decide whether an automatic molt should fire. All conditions required:
 * auto mode, usage above threshold, economics computed, candidates exist,
 * net savings positive (or unknown pricing with a large candidate mass).
 */
export function shouldAutoMolt(
	state: MoltState,
	config: MoltConfig,
	economics: CacheEconomics,
	contextTokens: number,
	contextWindow: number | undefined,
	resolvedModelCost: SchedulerModelCost | undefined,
): ShouldAutoMoltResult {
	const empty: ShouldAutoMoltResult = {
		fire: false,
		candidateRanges: [],
		economics,
		candidateTokens: 0,
		projectSavingsUsd: 0,
	};
	if (state.manualMode || !config.auto) return empty;
	if (!contextWindow || contextWindow <= 0) return empty;
	if (contextTokens / contextWindow <= config.maxContextPercent) return empty;

	// Candidates: completed, non-protected tool results older than protectTurns,
	// grouped into contiguous ranges capped at maxRangeTokens, largest first.
	const eligible = [...state.toolCalls.values()]
		.filter(
			(r) =>
				r.tokenEstimate > 0 &&
				r.timestamp > 0 &&
				!PROTECTED_TOOLS.has(r.toolName) &&
				!state.prunedToolIds.has(r.toolCallId) &&
				state.currentTurn - r.turnIndex >= config.protectTurns,
		)
		.sort((a, b) => b.tokenEstimate - a.tokenEstimate);

	const maxRange = config.maxRangeTokens;
	const ranges: Range[] = [];
	let current: Range | undefined;
	let currentTokens = 0;
	for (const record of eligible) {
		if (!current || currentTokens + record.tokenEstimate > maxRange) {
			current = { toolCallIds: [record.toolCallId], tokenEstimate: record.tokenEstimate };
			ranges.push(current);
			currentTokens = record.tokenEstimate;
		} else {
			current.toolCallIds.push(record.toolCallId);
			currentTokens += record.tokenEstimate;
		}
	}
	if (ranges.length === 0) return empty;

	const candidateTokens = ranges.reduce((sum, r) => sum + r.tokenEstimate, 0);
	const bustCost = projectBustCostUsd(contextTokens, economics);
	const modelCost = resolvedModelCost?.cost;
	const summarizerCostEstimate =
		1000 * (typeof modelCost?.input === "number" ? modelCost.input : 0) +
		600 * (typeof modelCost?.output === "number" ? modelCost.output : 0);
	// The cache bust is paid once; candidate savings recur on every subsequent
	// request. Count savings over a fixed horizon of remaining requests —
	// without it the one-time bust always dominates and the scheduler is dead.
	const SAVINGS_HORIZON_REQUESTS = 50;
	const projectSavingsUsd =
		candidateTokens * economics.readRate * SAVINGS_HORIZON_REQUESTS - bustCost - summarizerCostEstimate;

	const fire =
		projectSavingsUsd > 0 ||
		(economics.readRate === 0 && economics.writeRate === 0 && candidateTokens > 20_000);

	return { fire, candidateRanges: fire ? ranges : [], economics, candidateTokens, projectSavingsUsd };
}
