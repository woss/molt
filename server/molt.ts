import { readdir, readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { moltStats } from "../shared/molt";

const ARCHIVE_DIR = join(homedir(), ".omp", "agent", "molt-archive");

export async function moltStatsHandler(_input: RpcInput<typeof moltStats>) {
	let archivedOriginals = 0;
	let recentHashes: string[] = [];
	try {
		const files = (await readdir(ARCHIVE_DIR)).filter((f: string) => f.endsWith(".json"));
		archivedOriginals = files.length;
		recentHashes = files
			.map((f: string) => f.replace(/\.json$/, ""))
			.sort()
			.slice(-8);
	} catch {
		// no archive yet
	}

	// Latest molt-state custom entry from the most recent omp session file.
	const stats = {
		blocks: 0,
		tokensSaved: 0,
		realSpendUsd: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		inputTokens: 0,
	};
	// Aggregated molt-metric rows (append-only) from that session.
	const metrics = {
		blockSavedTokens: 0,
		passSavedTokens: 0,
		passes: 0,
	};
	try {
		const sessionsDir = join(homedir(), ".omp", "agent", "sessions");
		let newest: { file: string; mtime: number } | null = null;
		for (const slug of readdirSyncFs(sessionsDir)) {
			try {
				for (const f of readdirSyncFs(join(sessionsDir, slug))) {
					if (!f.endsWith(".jsonl")) continue;
					const full = join(sessionsDir, slug, f);
					const mtime = statSync(full).mtimeMs;
					if (!newest || mtime > newest.mtime) newest = { file: full, mtime };
				}
			} catch {
				// skip unreadable slugs
			}
		}
		if (newest) {
			const text = await readFile(newest.file, "utf8");
			for (const line of text.split("\n")) {
				if (!line.includes("molt-state") && !line.includes("molt-metric")) continue;
				try {
					const entry = JSON.parse(line);
					const data = entry?.data ?? entry?.custom?.data;
					if (data?.kind === "block") {
						metrics.blockSavedTokens += data.savedTokens ?? 0;
						continue;
					}
					if (data?.kind === "pass") {
						metrics.passSavedTokens += data.savedTokens ?? 0;
						metrics.passes += 1;
						continue;
					}
					if (!data?.blocks) continue;
					stats.blocks = data.blocks.length;
					stats.tokensSaved = data.tokensSaved ?? 0;
					stats.realSpendUsd = data.realSpendUsd ?? 0;
					stats.cacheReadTokens = data.cacheReadTokens ?? 0;
					stats.cacheWriteTokens = data.cacheWriteTokens ?? 0;
					stats.inputTokens = data.inputTokens ?? 0;
				} catch {
					// skip malformed lines
				}
			}
		}
	} catch {
		// no sessions dir
	}

	return { archivedOriginals, recentHashes, ...stats, metrics };
}
