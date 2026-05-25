import { Editor } from "@tiptap/core";
import { renderPmDocToMarkdown } from "@/features/export/exportEngine";
import {
  getFileBackedEditorExtensions,
  isStrictLineBreaks,
} from "./fileBackedEditorExtensions";

/**
 * ProseMirror JSON string/object → GFM markdown.
 *
 * Mirrors the parser's `breaks` mode (read from `editor.markdownStrictLineBreaks`)
 * so hardBreak nodes round-trip in both modes. Without this, a hardBreak written
 * under strict mode re-parses as a soft break (space) on the next read and the
 * line break is silently lost.
 */
export function pmJsonToMarkdown(
  content: string | Record<string, unknown>,
): string {
  const json = typeof content === "string" ? content : JSON.stringify(content);
  return renderPmDocToMarkdown(json, {
    strictLineBreaks: isStrictLineBreaks(),
  });
}

/** GFM markdown → ProseMirror JSON object (requires DOM — use in browser/tests). */
export function markdownToPmJson(markdown: string): Record<string, unknown> {
  const editor = new Editor({
    extensions: getFileBackedEditorExtensions(),
    content: normalizeImportedMarkdown(markdown),
  });
  try {
    return normalizeImportedDoc(editor.getJSON() as Record<string, unknown>);
  } finally {
    editor.destroy();
  }
}

/**
 * Insert a blank line before stand-alone `---` lines (3 or more dashes,
 * optionally indented up to 3 spaces) that immediately follow non-blank
 * content. CommonMark interprets such lines as Setext H2 underlines and
 * promotes the prior paragraph into a heading — almost never the intent in
 * AI-generated / convention-following markdown that uses `---` as a horizontal
 * rule. We do NOT touch `***` / `___` (no Setext ambiguity) nor 1–2 dashes
 * (intentional Setext H2 with short underline). Code fences are skipped.
 */
function normalizeImportedMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1]!;
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
      }
    }
    const promotesPrevToSetextH2 =
      !inFence &&
      /^\s{0,3}-{3,}\s*$/.test(line) &&
      i > 0 &&
      lines[i - 1]!.trim() !== "";
    if (promotesPrevToSetextH2) {
      out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
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
