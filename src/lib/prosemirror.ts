/** Convert a ProseMirror JSON content string to plain text. */
export function prosemirrorToText(content: string): string {
  try {
    const doc = JSON.parse(content);
    return extractText(doc);
  } catch {
    return content;
  }
}

/**
 * DB に保存された本文を TipTap `content` / `setContent` 向けに変換する。
 * シーン・スニペット・Codex は ProseMirror JSON 文字列。`{` で始まらない場合は HTML 等のレガシー文字列としてそのまま渡す。
 */
export function tiptapContentFromDb(
  raw: string | null | undefined,
): string | Record<string, unknown> {
  if (raw == null || raw === "" || raw === "{}") return "";
  const t = raw.trim();
  if (!t.startsWith("{")) return raw;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return raw;
  }
}

function extractText(node: {
  type?: string;
  text?: string;
  content?: unknown[];
}): string {
  if (node.text) return node.text;
  if (!node.content) return "";
  const parts = node.content.map((child) => extractText(child as typeof node));
  if (node.type === "paragraph" || node.type === "heading") {
    return parts.join("") + "\n";
  }
  return parts.join("");
}
