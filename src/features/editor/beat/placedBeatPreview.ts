import type { Node as PMNode } from "@tiptap/pm/model";

const MAX_BEATS = 8;
const MAX_CHARS_PER_BEAT = 60;

/**
 * Walk a serialized ProseMirror document JSON and extract placed-beat
 * (sceneBeat) preview lines as a JSON array string.
 *
 * NOTE: this couples to PM JSON shape (`{ type, content: [{ type, text }] }`).
 * That coupling is intentional — `extractUnplacedBeatPreview` operates on the
 * same shape and `tree/api.ts` calls this off the serialized doc string we
 * already store, without needing the editor schema at the API layer.
 */
type PmNodeJson = {
  type?: string;
  text?: string;
  content?: PmNodeJson[];
};

function getInlineText(node: PmNodeJson | undefined): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  let out = "";
  for (const child of node.content) out += getInlineText(child);
  return out;
}

function walk(node: PmNodeJson | undefined, items: string[]): void {
  if (!node || items.length >= MAX_BEATS) return;
  if (node.type === "sceneBeat") {
    const raw = getInlineText(node).trim();
    if (raw) {
      const normalized = raw.replace(/[\n\r\t]+/g, " ").trim();
      items.push(normalized.slice(0, MAX_CHARS_PER_BEAT));
    }
    return; // don't descend into sceneBeat children
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (items.length >= MAX_BEATS) break;
      walk(child, items);
    }
  }
}

export function extractPlacedBeatPreview(docJson: unknown): string {
  const items: string[] = [];
  if (docJson && typeof docJson === "object") {
    walk(docJson as PmNodeJson, items);
  }
  return JSON.stringify(items);
}

/**
 * PMNode-form variant of {@link extractPlacedBeatPreview}. Used by the live
 * editor path to avoid an extra full-doc serialisation per transaction.
 * Output format is identical to the JSON-form extractor.
 */
export function extractPlacedBeatPreviewFromDoc(doc: PMNode): string {
  const items: string[] = [];
  doc.descendants((node) => {
    if (items.length >= MAX_BEATS) return false;
    if (node.type.name === "sceneBeat") {
      const raw = node.textContent.trim();
      if (raw) {
        const normalized = raw.replace(/[\n\r\t]+/g, " ").trim();
        items.push(normalized.slice(0, MAX_CHARS_PER_BEAT));
      }
      return false;
    }
    return true;
  });
  return JSON.stringify(items);
}

/** Parse a serialized PM JSON string and extract previews. Empty/invalid → "[]". */
export function extractPlacedBeatPreviewFromString(
  contentJsonStr: string,
): string {
  if (!contentJsonStr || contentJsonStr === "{}") return "[]";
  try {
    const parsed: unknown = JSON.parse(contentJsonStr);
    return extractPlacedBeatPreview(parsed);
  } catch {
    return "[]";
  }
}
