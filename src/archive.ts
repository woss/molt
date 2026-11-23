// molt — original-message archive (fork ccr.ts pattern, local disk, no TTL)

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const ARCHIVE_DIR = join(homedir(), ".omp", "agent", "molt-archive");

/** Persist minified JSON of the original messages; returns the sha256-slice-24 hash. */
export async function persistOriginal(messages: unknown[]): Promise<string> {
	const json = JSON.stringify(messages);
	const hash = createHash("sha256").update(json).digest("hex").slice(0, 24);
	await mkdir(ARCHIVE_DIR, { recursive: true });
	await writeFile(join(ARCHIVE_DIR, `${hash}.json`), json, "utf8");
	return hash;
}
