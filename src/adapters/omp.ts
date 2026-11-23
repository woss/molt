// omp adapter — wires pi-coding-agent hooks into molt's engine.
// The only host-coupled file: session persistence, prompt hook, event shapes,
// model resolution (@oh-my-pi/pi-ai complete), and metric persistence.

import { complete } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { MOLT_SYSTEM_PROMPT, SUMMARIZER_SYSTEM_PROMPT } from "../core/prompt.ts";
import { cacheEconomics } from "../core/telemetry.ts";
import { createInputFingerprint, createState, deserializeMoltState, serializeMoltState, type MoltState, type ToolRecord } from "../core/state.ts";
import type { ContextEvent, ContextEventResult, HostAdapter, MoltMessage, MoltToolDef, MoltMetricEntry, Summarizer, TelemetrySpend, ToolExecResult } from "../types.ts";

type AnyMsg = Record<string, any>; // pi message shapes — existing house convention for this boundary

/** Build the omp HostAdapter + Summarizer sharing one session-context handle. */
export function createOmp(pi: ExtensionAPI): { adapter: HostAdapter; summarizer: Summarizer } {
	const state: MoltState = createState();
	let latestCtx: any = null;
	let toolRecordSink: ((record: ToolRecord) => void) | null = null;
	let spendSink: ((spend: TelemetrySpend) => void) | null = null;
	let contextSink: ((event: ContextEvent) => Promise<ContextEventResult>) | null = null;

	// ── session lifecycle: restore + persist (host-specific) ────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (ctx?.hasUI) latestCtx = ctx;
		for (const entry of ctx.sessionManager.getBranch()) {
			if ((entry as AnyMsg).type === "custom" && (entry as AnyMsg).customType === "molt-state") {
				const restored = deserializeMoltState((entry as AnyMsg).data);
				if (restored) Object.assign(state, restored);
			}
		}
	});

	const saveState = () => {
		pi.appendEntry("molt-state", serializeMoltState(state));
	};
	pi.on("session_shutdown", async () => saveState());
	pi.on("agent_end", async () => saveState());

	// ── before_agent_start: molt guidance on the system prompt ──────────────
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: [...event.systemPrompt, MOLT_SYSTEM_PROMPT],
	}));

	// ── tool_call / tool_result: build ToolRecords ──────────────────────────
	pi.on("tool_call", async (event) => {
		if (state.toolCalls.has(event.toolCallId)) return;
		toolRecordSink?.({
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
			? event.content.map((c: AnyMsg) => (c?.type === "text" ? c.text : "")).join("")
			: "";
		const tokenEstimate = Math.round(outputText.length / 4);
		const record = state.toolCalls.get(event.toolCallId);
		if (record) {
			record.isError = event.isError === true;
			record.timestamp = Date.now();
			record.tokenEstimate = tokenEstimate;
		} else {
			toolRecordSink?.({
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
		if (ctx?.hasUI) latestCtx = ctx;
		const message = event.message as AnyMsg;
		const usage = message?.usage;
		const asNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		const cost = usage?.cost && typeof usage.cost === "object" ? usage.cost : {};
		const econ = cacheEconomics(ctx?.model);
		spendSink?.({
			inputTokens: asNum(usage?.input),
			cacheReadTokens: asNum(usage?.cacheRead),
			cacheWriteTokens: asNum(usage?.cacheWrite),
			spendUsd: asNum(cost.total),
			readRate: econ.readRate,
			writeRate: econ.writeRate,
		});
	});

	// ── context: bridge the pre-send splice point to the engine ─────────────
	pi.on("context", async (event, ctx) => {
		if (ctx?.hasUI) latestCtx = ctx;
		const usage = ctx.getContextUsage();
		const result = contextSink
			? await contextSink({
					messages: event.messages as unknown as MoltMessage[],
					tokens: usage?.tokens,
					contextWindow: usage?.contextWindow,
					modelCost: ctx?.model,
				})
			: { messages: event.messages as unknown as MoltMessage[] };
		return { messages: result.messages as never[] };
	});

	const adapter: HostAdapter = {
		state,
		onToolRecord(fn) {
			toolRecordSink = fn;
		},
		onMessageEnd(fn) {
			spendSink = fn;
		},
		onContextEvent(fn) {
			contextSink = fn;
		},
		registerTools(tools: MoltToolDef[]) {
			for (const tool of tools) {
				// registerTool<TParams extends TSchema> instantiates the typebox shim's
				// arktype-derived schema types infinitely deep; the runtime is duck-typed.
				const register = pi.registerTool.bind(pi) as (tool: unknown) => void;
				register({
					name: tool.name,
					label: tool.label,
					description: tool.description,
					parameters: tool.parameters,
					execute: (toolCallId: string, params: unknown): Promise<ToolExecResult> =>
						tool.execute(toolCallId, params as Record<string, unknown>),
				});
			}
		},
		sessionMessages(): MoltMessage[] {
			// pi session entries with `.messages` flattened to the branch's message list.
			return latestCtx?.sessionManager?.getBranch?.().filter((e: AnyMsg) => e.messages).flatMap((e: AnyMsg) => e.messages) ?? [];
		},
		appendMetric(entry: MoltMetricEntry) {
			pi.appendEntry("molt-metric", entry);
		},
		notify(message, level) {
			latestCtx?.ui?.notify?.(message, level);
		},
		log(level, message) {
			pi.logger?.[level]?.(message);
		},
	};

	const summarizer: Summarizer = {
		async callModel(modelId, input) {
			const ctx = latestCtx;
			if (!ctx) throw new Error("molt: no session context for summarizer");
			// Resolution fallback chain: configured id → current session model.
			const model = (await ctx.models.resolve(modelId)) ?? (await ctx.models.resolve("current")) ?? ctx.models.current();
			if (!model) throw new Error(`molt: model ${modelId} not resolvable`);
			const apiKey = ctx.models.getApiKey?.(model) ?? undefined;
			const response = await complete(
				model,
				{
					systemPrompt: [SUMMARIZER_SYSTEM_PROMPT],
					messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
				},
				{ apiKey, maxTokens: 4096, temperature: 0 },
			);
			if (response.errorMessage) throw new Error(`molt: summarizer error: ${response.errorMessage}`);
			return extractOutputText(response as unknown as { output: unknown });
		},
	};

	return { adapter, summarizer };
}

function extractOutputText(response: { output: unknown }): string {
	if (typeof response.output === "string") return response.output;
	if (Array.isArray(response.output)) {
		return response.output
			.map((p: any) => (p && typeof p === "object" && typeof (p as AnyMsg).text === "string" ? (p as AnyMsg).text : ""))
			.join("");
	}
	return "";
}
