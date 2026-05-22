import type { ChatMessage } from "@/features/chat/chatTypes";
import type { SummarizationPromptOptions } from "../ja/summarization";

export function buildSummarizationPromptEn(
  messages: ChatMessage[],
  opts?: SummarizationPromptOptions,
): string {
  const lines = messages.map((m) => {
    const roleLabel = m.role === "user" ? "User" : "Assistant";
    return `${roleLabel}: ${m.content}`;
  });

  const previousBlock = opts?.previousSummary
    ? `\n\n=== Previous generation summary ===\n${opts.previousSummary}\n`
    : "";

  return (
    `CONVERSATION CHECKPOINT — HANDOFF SUMMARY\n\n` +
    `You are creating a handoff summary for a fiction-writing session.\n` +
    `Structure the following so the next assistant can continue without losing context:\n\n` +
    `## Writing goals for this session\n` +
    `## Agreed decisions\n` +
    `## Mentioned Codex entries\n` +
    `## User style / tone preferences\n` +
    `## Drafts / proposals under review\n` +
    `## Open questions / pending actions\n\n` +
    `Output the summary only. Include an HTML comment on the first line:\n` +
    `<!-- gen=${opts?.generation ?? 1} source_msg_count=${messages.length} last_msg_id=... generated_at=... -->\n` +
    previousBlock +
    `\n=== Input messages ===\n` +
    lines.join("\n\n")
  );
}
