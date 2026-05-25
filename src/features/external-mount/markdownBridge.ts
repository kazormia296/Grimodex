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
 * (intentional Setext H2 with short underline).
 *
 * Skipped contexts:
 *  - fenced code blocks (``` / ~~~) — `---` is literal code
 *  - open multi-line raw HTML blocks (html:true mode) — inserting a blank line
 *    would terminate the HTML block (CommonMark rule 7) and the `---` would
 *    split off as an HR, leaving a floating closing tag paragraph (bug #3).
 *
 * The HTML detector is intentionally conservative — false positives only mean
 * a `---` doesn't get its blank line inserted (the pre-fix behaviour), while
 * false negatives reproduce bug #3. Over-skip is invisible; under-skip is a
 * regression.
 */
// HTML open-tag heuristic: line head starts with `<tag` followed by space, `>`,
// `/>`, or end-of-line. Permissive on what follows (`<div>text...` and
// `<div class="x">text...` both match) — false positives only suppress rescue,
// which is the pre-fix behaviour and harmless. End-anchoring the regex would
// miss `<div>text...` and reproduce bug #3 for that variant.
const HTML_OPEN_TAG_LINE = /^\s{0,3}<[a-zA-Z][a-zA-Z0-9-]*(?:\s|\/?>|$)/;
const HTML_CLOSE_TAG_ON_LINE = /<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/;
const HTML_CLOSE_ONLY_LINE = /^\s{0,3}<\/[a-zA-Z][a-zA-Z0-9-]*\s*>\s*$/;

function normalizeImportedMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  let inHtmlBlock = false;
  // Track a run of consecutive blank lines that started outside any code
  // fence / HTML block. When the run ends (or input ends), 2+ consecutive
  // blanks are rewritten so each *extra* blank becomes a `<p></p>` HTML
  // block — markdown-it preserves these (html:true), producing an empty
  // paragraph node, and the matching serializer (ParagraphWithEmptyLineSupport)
  // round-trips it back to `<p></p>`. Without expansion, markdown-it
  // (CommonMark) silently collapses any number of blank lines into a single
  // paragraph break and the extra blank lines vanish from the editor.
  //
  // `blankRunStart` is the index into `out` of the first blank in the
  // current run, or -1 when no run is open. Synthetic blanks inserted by
  // the Setext rescue below intentionally do NOT start a run — they aren't
  // user content and shouldn't be expanded.
  let blankRunStart = -1;

  function flushBlankRun(): void {
    if (blankRunStart < 0) return;
    const runLength = out.length - blankRunStart;
    if (runLength >= 2) {
      // N consecutive blanks → 1 blank + (N-1) × (`<p></p>` + blank).
      // The leading blank serves as the paragraph separator before the
      // first `<p></p>` block; each `<p></p>` needs a trailing blank to
      // be recognised as a CommonMark type-6 HTML block.
      const replacement: string[] = [""];
      for (let k = 0; k < runLength - 1; k++) {
        replacement.push("<p></p>", "");
      }
      out.splice(blankRunStart, runLength, ...replacement);
    }
    blankRunStart = -1;
  }

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
    if (!inFence) {
      if (!inHtmlBlock) {
        // Open only when the line starts with an HTML-ish tag AND does not
        // also close one on the same line (single-line `<span>x</span>`
        // doesn't open a multi-line block).
        if (
          HTML_OPEN_TAG_LINE.test(line) &&
          !HTML_CLOSE_TAG_ON_LINE.test(line)
        ) {
          inHtmlBlock = true;
        }
      } else if (line.trim() === "" || HTML_CLOSE_ONLY_LINE.test(line)) {
        // CommonMark type 6/7 blocks end on a blank line; we additionally
        // close on a stand-alone closing tag for the well-formed case.
        inHtmlBlock = false;
      }
    }
    const promotesPrevToSetextH2 =
      !inFence &&
      !inHtmlBlock &&
      /^\s{0,3}-{3,}\s*$/.test(line) &&
      i > 0 &&
      lines[i - 1]!.trim() !== "";

    const isSafeContext = !inFence && !inHtmlBlock;
    const isBlank = line.trim() === "";

    // The blank run ends here unless this line is itself a safe-context
    // blank. Flush BEFORE pushing the non-blank line so `runLength` counts
    // only the blanks, not the line that terminates the run.
    if (!(isSafeContext && isBlank)) {
      flushBlankRun();
    }

    if (promotesPrevToSetextH2) {
      out.push("");
      // Synthetic — do not enter a blank run on it (it wasn't user-authored
      // and shouldn't be expanded into `<p></p>`).
    }
    out.push(line);

    if (isSafeContext && isBlank && blankRunStart < 0) {
      blankRunStart = out.length - 1;
    }
  }
  flushBlankRun();
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
