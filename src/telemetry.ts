// molt — real-spend + cache economics

import type { MoltState } from "./state.ts";

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Accumulate one finalized assistant message's usage snapshot (message_end). */
export function recordUsage(
	state: MoltState,
	usage: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } } | undefined | null,
): void {
	if (!usage) return;
	state.inputTokens += Math.max(0, asNumber(usage.input));
	state.cacheReadTokens += Math.max(0, asNumber(usage.cacheRead));
	state.cacheWriteTokens += Math.max(0, asNumber(usage.cacheWrite));
	const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : {};
	state.realSpendUsd += Math.max(0, asNumber(cost.total));
}

export interface CacheEconomics {
	readRate: number;
	writeRate: number;
}

/** Real cache rates ($/token) from ctx.model.cost; 0/0 when unknown (favors rewriting). */
export function cacheEconomics(model: { cost?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown } } | undefined | null): CacheEconomics {
	const cost = model?.cost;
	if (!cost) return { readRate: 0, writeRate: 0 };
	const readRate = asNumber(cost.cacheRead);
	const writeRate = asNumber(cost.cacheWrite);
	if (readRate <= 0 && writeRate <= 0) return { readRate: 0, writeRate: 0 };
	return { readRate: Math.max(0, readRate), writeRate: Math.max(0, writeRate) };
}

/** One-time cost of busting the prompt cache: context re-read at write rate minus read rate. */
export function projectBustCostUsd(contextTokens: number, econ: CacheEconomics): number {
	return Math.max(0, contextTokens) * (econ.writeRate - econ.readRate);
}
