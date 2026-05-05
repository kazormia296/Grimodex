import { invoke } from "@/lib/tauri";
import type { AiBranchCard } from "./mapApi";

interface LLMResponsePayload {
  blocks: Array<
    | { type: "text"; content: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "thinking"; content: string }
  >;
  stopReason: string;
  inputTokens?: number;
  outputTokens?: number;
}

function buildPrompt(
  userPrompt: string,
  count: number,
  seedContext: string[],
): string {
  const contextLine =
    seedContext.length > 0 ? `コンテキスト: ${seedContext.join("、")}\n\n` : "";
  return (
    `${contextLine}以下のテーマについて、異なる視点から ${count} 個のアイデアをください。\n\n` +
    `テーマ: ${userPrompt}\n\n` +
    `各アイデアは次の形式で出力してください（必ず ${count} 個、区切りは "---" のみ）:\n\n` +
    `## タイトル\n本文テキスト\n\n---\n\n` +
    `最後の区切り "---" は不要です。余分な説明は不要です。`
  );
}

function parseCards(text: string, count: number): AiBranchCard[] {
  const segments = text
    .split(/\n---\n|\n---$/)
    .map((s) => s.trim())
    .filter(Boolean);

  const cards: AiBranchCard[] = segments.slice(0, count).map((seg) => {
    const lines = seg.split("\n");
    const isHeader = lines[0].startsWith("## ") || lines[0].startsWith("# ");
    const title = isHeader
      ? lines[0].replace(/^#{1,3}\s*/, "").trim()
      : lines[0].trim();
    const bodyLines = lines.slice(1);

    const bodyText = bodyLines
      .join("\n")
      .trim()
      .replace(/^[\s\n]+/, "");

    const paragraphs = bodyText
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    const content =
      paragraphs.length > 0
        ? paragraphs.map((p) => ({
            type: "paragraph",
            content: [{ type: "text", text: p }],
          }))
        : [{ type: "paragraph", content: [] }];

    const body = JSON.stringify({ type: "doc", content });

    return { title, body };
  });

  // Pad with empty cards if LLM returned fewer than requested
  while (cards.length < count) {
    cards.push({
      title: `アイデア ${cards.length + 1}`,
      body: '{"type":"doc","content":[]}',
    });
  }

  return cards;
}

export async function generateAiBranchCards(
  prompt: string,
  count: number,
  seedContext: string[] = [],
): Promise<AiBranchCard[]> {
  const userPrompt = buildPrompt(prompt, count, seedContext);

  const response = await invoke<LLMResponsePayload>("send_chat_message", {
    messages: [{ role: "user", content: userPrompt }],
    thinking: null,
    effort: null,
    reasoningEnabled: null,
    reasoningEffort: null,
  });

  const text = response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");

  return parseCards(text, count);
}
