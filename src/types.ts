// molt — host boundary. The only file an adapter author reads: the engine
// (core/) talks to any harness exclusively through HostAdapter + Summarizer.
import type { MoltState, ToolRecord } from "./core/state.ts";

/** Host message surface: minimal structural shape molt reads (role/id/timestamp/content/usage). */
export type MoltMessage = Record<string, unknown>;

export interface ToolExecResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details?: Record<string, unknown>;
}

/** Host-agnostic tool definition; `parameters` is a TypeBox schema object. */
export interface MoltToolDef {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolExecResult>;
}

/** One assistant turn's real spend, extracted from the host's usage payload. */
export interface TelemetrySpend {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	spendUsd: number;
	readRate: number;
	writeRate: number;
}

/** Pre-send splice point: the engine prunes + nudges the message list before the host sends it. */
export interface ContextEvent {
	messages: MoltMessage[];
	tokens?: number;
	contextWindow?: number;
	/** Structural subset the scheduler prices; the host passes what its model object exposes. */
	modelCost?: { cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } };
}

export interface ContextEventResult {
	messages: MoltMessage[];
}

export type MoltMetricEntry =
	| { kind: "pass"; ts: number; tokensBefore: number; tokensAfter: number; savedTokens: number; activeBlocks: number }
	| {
			kind: "block";
			ts: number;
			blockIds?: number[];
			topic: string;
			sourceTokens: number;
			summaryTokens: number;
			savedTokens: number;
	  };

/**
 * The touchpoints molt needs from a host. Message identity: block ranges
 * reference stable per-message IDs; core derives them from message
 * `id`/`timestamp` at the splice point, so a host without native IDs must
 * stamp fingerprint IDs in its adapter — that is where adapters get
 * non-trivial, not in the wiring.
 */
export interface HostAdapter {
	/** Adapter-created state; persistence/restore is host-specific, so the host owns it. */
	readonly state: MoltState;
	/** Tool activity (fingerprint, turnIndex, tokenEstimate). */
	onToolRecord(fn: (record: ToolRecord) => void): void;
	/** Real cache read/write spend per assistant message. */
	onMessageEnd(fn: (spend: TelemetrySpend) => void): void;
	/**
	 * Optional pre-send splice point. Hosts without a context hook omit it;
	 * the engine then degrades to eager-tool-only mode (the molt tool still works).
	 */
	onContextEvent?(fn: (event: ContextEvent) => Promise<ContextEventResult>): void;
	registerTools(tools: MoltToolDef[]): void;
	/** Current branch's messages, for range collection and archiving. */
	sessionMessages(): MoltMessage[];
	appendMetric(entry: MoltMetricEntry): void;
	notify?(message: string, level: "info" | "warn" | "error"): void;
	log?(level: "info" | "warn", message: string): void;
}

/** Model-call boundary: swapping model APIs means writing a Summarizer, not touching the engine. */
export interface Summarizer {
	/** Resolve the model id, send `input`, resolve with the raw reply text. */
	callModel(modelId: string, input: string): Promise<string>;
}
