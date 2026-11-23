// molt — block/record shapes and persistence round-trip
// Ported from complexthings/pi-dynamic-context-pruning state.ts (molt naming).

export interface ToolRecord {
	toolCallId: string;
	toolName: string;
	inputArgs: Record<string, unknown>;
	inputFingerprint: string;
	isError: boolean;
	turnIndex: number;
	timestamp: number;
	tokenEstimate: number;
}

export interface CompressionBlock {
	id: number;
	topic: string;
	summary: string;
	startTimestamp: number;
	endTimestamp: number;
	/** First message ts AFTER the range; Infinity in-memory for end-of-conversation, null when persisted. */
	anchorTimestamp: number;
	/** Estimated tokens of the raw range at creation; 0 for blocks created before metering. */
	sourceTokens: number;
	active: boolean;
	summaryTokenEstimate: number;
	createdAt: number;
}

export interface MoltState {
	toolCalls: Map<string, ToolRecord>;
	prunedToolIds: Set<string>;
	compressionBlocks: CompressionBlock[];
	nextBlockId: number;
	messageIdSnapshot: Map<string, number>;
	currentTurn: number;
	realSpendUsd: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputTokens: number;
	tokensSaved: number;
	readRate: number;
	writeRate: number;
	manualMode: boolean;
}

export function createState(): MoltState {
	return {
		toolCalls: new Map(),
		prunedToolIds: new Set(),
		compressionBlocks: [],
		nextBlockId: 1,
		messageIdSnapshot: new Map(),
		currentTurn: 0,
		realSpendUsd: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		inputTokens: 0,
		tokensSaved: 0,
		readRate: 0,
		writeRate: 0,
		manualMode: false,
	};
}

function sortObjectKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortObjectKeys);
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) sorted[key] = sortObjectKeys(obj[key]);
		return sorted;
	}
	return value;
}

export function createInputFingerprint(toolName: string, args: Record<string, unknown>): string {
	return `${toolName}::${JSON.stringify(sortObjectKeys(args))}`;
}

export interface SerializedMoltState {
	blocks: Array<Omit<CompressionBlock, "anchorTimestamp"> & { anchorTimestamp: number | null }>;
	nextBlockId: number;
	prunedToolIds: string[];
	tokensSaved: number;
	readRate: number;
	writeRate: number;
	manualMode: boolean;
	realSpendUsd: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputTokens: number;
}

export function serializeMoltState(state: MoltState): SerializedMoltState {
	return {
		blocks: state.compressionBlocks.map((b) => ({
			...b,
			// JSON cannot carry Infinity — persist null, repair on load.
			anchorTimestamp: Number.isFinite(b.anchorTimestamp) ? b.anchorTimestamp : null,
		})),
		nextBlockId: state.nextBlockId,
		prunedToolIds: [...state.prunedToolIds],
		tokensSaved: state.tokensSaved,
		readRate: state.readRate,
		writeRate: state.writeRate,
		manualMode: state.manualMode,
		realSpendUsd: state.realSpendUsd,
		cacheReadTokens: state.cacheReadTokens,
		cacheWriteTokens: state.cacheWriteTokens,
		inputTokens: state.inputTokens,
	};
}

export function deserializeMoltState(raw: unknown): Partial<MoltState> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const data = raw as Partial<SerializedMoltState>;
	if (!Array.isArray(data.blocks)) return undefined;
	const rawBlocks = data.blocks as Array<Record<string, unknown>>;
	const validBlocks: CompressionBlock[] = rawBlocks
		.filter(
			(b) =>
				Number.isFinite(b?.startTimestamp) &&
				Number.isFinite(b?.endTimestamp) &&
				(b.anchorTimestamp === null || Number.isFinite(b.anchorTimestamp)),
		)
		.map((b) => ({
			id: Number(b.id),
			topic: String(b.topic ?? ""),
			summary: String(b.summary ?? ""),
			startTimestamp: Number(b.startTimestamp),
			endTimestamp: Number(b.endTimestamp),
			// anchorTimestamp is Infinity in-memory for end-of-conversation blocks;
			// JSON round-trips it as null — repair to endTimestamp + 0.5 on load.
			anchorTimestamp:
				typeof b.anchorTimestamp === "number" && Number.isFinite(b.anchorTimestamp)
					? b.anchorTimestamp
					: Number(b.endTimestamp) + 0.5,
			active: b.active !== false,
			sourceTokens: Math.max(0, Number(b.sourceTokens ?? 0)),
			summaryTokenEstimate: Number(b.summaryTokenEstimate ?? 0),
			createdAt: Number(b.createdAt ?? 0),
		}));
	return {
		compressionBlocks: validBlocks,
		nextBlockId:
			data.nextBlockId ??
			(validBlocks.length > 0 ? Math.max(0, ...validBlocks.map((b) => b.id)) + 1 : 1),
		prunedToolIds: new Set(data.prunedToolIds ?? []),
		tokensSaved: data.tokensSaved ?? 0,
		readRate: data.readRate ?? 0,
		writeRate: data.writeRate ?? 0,
		manualMode: data.manualMode ?? false,
		realSpendUsd: data.realSpendUsd ?? 0,
		cacheReadTokens: data.cacheReadTokens ?? 0,
		cacheWriteTokens: data.cacheWriteTokens ?? 0,
		inputTokens: data.inputTokens ?? 0,
	};
}
