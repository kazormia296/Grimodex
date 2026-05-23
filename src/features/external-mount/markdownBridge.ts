import { Editor } from "@tiptap/core";
import { renderPmDocToMarkdown } from "@/features/export/exportEngine";
import { getFileBackedEditorExtensions } from "./fileBackedEditorExtensions";

/** ProseMirror JSON string/object → GFM markdown. */
export function pmJsonToMarkdown(
  content: string | Record<string, unknown>,
): string {
  const json = typeof content === "string" ? content : JSON.stringify(content);
  return renderPmDocToMarkdown(json);
}

/** GFM markdown → ProseMirror JSON object (requires DOM — use in browser/tests). */
export function markdownToPmJson(markdown: string): Record<string, unknown> {
  const editor = new Editor({
    extensions: getFileBackedEditorExtensions(),
    content: markdown,
  });
  try {
    return normalizeImportedDoc(editor.getJSON() as Record<string, unknown>);
  } finally {
    editor.destroy();
  }
}

function normalizeImportedDoc(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const content = doc.content;
  if (!Array.isArray(content)) return doc;

  const trimmed = [...content];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1] as Record<string, unknown>;
    if (
      last.type === "paragraph" &&
      (!Array.isArray(last.content) || last.content.length === 0)
    ) {
      trimmed.pop();
      continue;
    }
    break;
  }

  return trimmed.length === content.length ? doc : { ...doc, content: trimmed };
}

/** Strip unsupported marks/nodes from pasted rich content. */
export { sanitizePastedMarkdown } from "./fileBackedEditorExtensions";
