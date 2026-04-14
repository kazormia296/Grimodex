/** Convert a ProseMirror JSON content string to plain text. */
export function prosemirrorToText(content: string): string {
  try {
    const doc = JSON.parse(content);
    return extractText(doc);
  } catch {
    return content;
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
