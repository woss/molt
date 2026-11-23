// molt — prompt text

export const SUMMARIZER_SYSTEM_PROMPT =
	`You compress stale agent conversation ranges. Return JSON {topic, ranges:[{startId,endId,summary}]} where each summary is an exhaustive technical summary preserving file paths, commands, errors, decisions, and current values; omit nothing a later engineer needs.`.trim();

export const MOLT_SYSTEM_PROMPT = `
You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality.

The tool for context management is \`molt\`. It replaces older conversation content with technical summaries you produce. Originals of scheduler-molted sections are retrievable via \`molt_expand\` using the hash in the "Expand originals: molt_expand hash=<hash>" marker.

\`<molt-id>\` and \`<molt-system-reminder>\` tags are environment-injected metadata. Do not output them.

PHILOSOPHY
\`molt\` crystallizes conversation: raw exploration becomes refined understanding. Your summary becomes the authoritative record of what transpired.

COMPRESS WHEN a section is genuinely closed: research concluded, implementation finished and verified, dead-end noise discardable.

DO NOT COMPRESS raw context still needed for edits, precise references, or active work.

Prefer small, closed, summary-safe compressions; batch independent ranges in one call. Use steady housekeeping — regular small molts over infrequent massive ones.

Use only boundary IDs visible in context (\`mNNN\` for messages, \`bN\` for molted blocks); \`startId\` must appear before \`endId\`. Never invent IDs.
`.trim();

export const CONTEXT_STRONG_NUDGE = `<molt-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED. This is an emergency context-recovery moment. You MUST use the \`molt\` tool now on one large, closed, high-yield range of older, resolved history. Preserve user intent exactly; summaries must cover all essential details so work continues without reopening raw messages.
</molt-system-reminder>`;

export const CONTEXT_SOFT_NUDGE = `<molt-system-reminder>
Context usage is high. Look for a closed, self-contained older range and compress it now with the \`molt\` tool. If nothing is cleanly closed yet, continue — but molt at the earliest opportunity.
</molt-system-reminder>`;

export const TURN_NUDGE = `<molt-system-reminder>
Evaluate the conversation for compressible ranges. If any range is cleanly closed and unlikely to be needed again, use the \`molt\` tool on it. Keep active context uncompressed.
</molt-system-reminder>`;

export const ITERATION_NUDGE = `<molt-system-reminder>
You've been iterating a while since the last user message. If a closed portion is unlikely to be referenced immediately, use the \`molt\` tool on it now.
</molt-system-reminder>`;
