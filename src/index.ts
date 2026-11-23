// molt — omp extension entry: picks the host adapter, delegates to the engine.
// Writing another harness? Implement HostAdapter + Summarizer (./types.ts) and
// call core's molt() the same way; engine code stays untouched.

import { molt } from "./core/engine.ts";
import { createOmp } from "./adapters/omp.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export * from "./types.ts";

export default function moltOmp(pi: ExtensionAPI) {
	const { adapter, summarizer } = createOmp(pi);
	molt(adapter, summarizer);
}
