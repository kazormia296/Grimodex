interface PMNode {
  type: string;
  text?: string;
  content?: PMNode[];
}

function collectText(node: PMNode, parts: string[]): void {
  if (node.text) {
    parts.push(node.text);
  }
  if (node.content) {
    for (const child of node.content) {
      collectText(child, parts);
    }
  }
}

/**
 * Convert a ProseMirror JSON string to plain text.
 * Returns "" if the input is empty or invalid JSON.
 */
export function extractPlainText(jsonStr: string): string {
  if (!jsonStr) return "";

  let doc: PMNode;
  try {
    doc = JSON.parse(jsonStr) as PMNode;
  } catch {
    return "";
  }

  const parts: string[] = [];
  collectText(doc, parts);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}
