import type { Node as PMNode } from "@tiptap/pm/model";

const MAX_BEATS = 8;
const MAX_CHARS_PER_BEAT = 60;

/**
 * Walk a ProseMirror document and extract placed beat (sceneBeat) preview lines
 * as a JSON array string. Mirrors `extractUnplacedBeatPreview`'s output shape so
 * the Grid card can parse both the same way.
 *
 * Returns "[]" when there are no sceneBeat nodes.
 */
export function extractPlacedBeatPreview(doc: PMNode): string {
  const items: string[] = [];
  doc.descendants((node) => {
    if (items.length >= MAX_BEATS) return false;
    if (node.type.name === "sceneBeat") {
      const raw = node.textContent.trim();
      if (raw) {
        const normalized = raw.replace(/[\n\r\t]+/g, " ").trim();
        items.push(normalized.slice(0, MAX_CHARS_PER_BEAT));
      }
      // sceneBeat children are inline text; skip descending further.
      return false;
    }
    return true;
  });
  return JSON.stringify(items);
}
