import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";

export interface AttributedSegment {
  text: string;
  source: AuthorshipSource;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Copy text to clipboard with Grimodex attribution metadata.
 * Sets both `text/plain` and `text/html` (with `data-grimodex-source` wrapper).
 */
export async function copyWithAttribution(
  text: string,
  source: AuthorshipSource,
): Promise<void> {
  const html = `<span data-grimodex-source="${source}">${escapeHtml(text)}</span>`;
  const item = new ClipboardItem({
    "text/plain": new Blob([text], { type: "text/plain" }),
    "text/html": new Blob([html], { type: "text/html" }),
  });
  await navigator.clipboard.write([item]);
}

/**
 * Intercept a native copy event to inject Grimodex attribution metadata.
 * Use as an `onCopy` handler on elements whose text should carry attribution.
 */
export function handleCopyWithAttribution(
  event: React.ClipboardEvent,
  source: AuthorshipSource,
): void {
  const selection = window.getSelection();
  const text = selection?.toString() ?? "";
  if (!text) return;

  event.preventDefault();
  const html = `<span data-grimodex-source="${source}">${escapeHtml(text)}</span>`;
  event.clipboardData.setData("text/plain", text);
  event.clipboardData.setData("text/html", html);
}

/**
 * Parse clipboard HTML to extract attributed segments.
 *
 * Returns segments in these cases:
 * 1. `data-grimodex-source` present → Codex/Snippet copy
 * 2. `span[data-authorship]` present → editor body copy
 * 3. Otherwise → `null` (external paste)
 */
export function parseClipboardHtml(
  html: string | undefined,
): AttributedSegment[] | null {
  if (!html) return null;

  const doc = new DOMParser().parseFromString(html, "text/html");

  // Case 1: Codex/Snippet copy (data-grimodex-source wrapper)
  const grimodexEl = doc.querySelector("[data-grimodex-source]");
  if (grimodexEl) {
    const source = grimodexEl.getAttribute(
      "data-grimodex-source",
    ) as AuthorshipSource;
    const text = grimodexEl.textContent ?? "";
    if (text) return [{ text, source }];
    return null;
  }

  // Case 2: TipTap/ProseMirror editor copy.
  // ProseMirror sets data-pm-slice on the outermost clipboard element.
  // data-authorship spans mark attributed (ai/unknown) text; absence means human.
  // Both signals are checked so that human-only copies (no authorship spans but
  // data-pm-slice present) are also handled and attributed as "human" rather than
  // falling through to the plain-text "unknown" path below.
  const isEditorCopy =
    doc.body.querySelector("[data-pm-slice]") !== null ||
    doc.body.querySelector("span[data-authorship]") !== null;
  if (isEditorCopy) {
    const segments = extractMixedSegments(doc.body);
    if (segments.length > 0) return segments;
  }

  return null;
}

// Block-level tags whose boundaries represent paragraph separators.
// DIV is intentionally excluded: ProseMirror wraps clipboard HTML in
// <div data-pm-slice="…">, which is a structural container, not a paragraph.
// Treating it as a block would cause firstBlock to flip prematurely, injecting
// a spurious leading "\n" before the first real paragraph.
const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "LI",
]);

/**
 * Walk DOM nodes to extract text with attribution, handling mixed
 * marked/unmarked content from editor copy.
 * Block-level elements (p, h1-h6, blockquote, li) are separated
 * by "\n" so callers can reconstruct paragraph structure.
 */
function extractMixedSegments(root: Element): AttributedSegment[] {
  const segments: AttributedSegment[] = [];
  let firstBlock = true;

  function appendText(text: string, source: AuthorshipSource): void {
    const last = segments[segments.length - 1];
    if (last && last.source === source) {
      last.text += text;
    } else {
      segments.push({ text, source });
    }
  }

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text) return;
      const parentSpan = (node.parentElement as Element | null)?.closest?.(
        "span[data-authorship]",
      );
      const source: AuthorshipSource = parentSpan
        ? ((parentSpan.getAttribute("data-authorship") ??
            "unknown") as AuthorshipSource)
        : "human";
      appendText(text, source);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (BLOCK_TAGS.has(el.tagName)) {
        if (!firstBlock) {
          // Paragraph separator before each block except the first
          const last = segments[segments.length - 1];
          if (last) last.text += "\n";
          else segments.push({ text: "\n", source: "human" });
        }
        firstBlock = false;
      }
      for (const child of el.childNodes) {
        walk(child);
      }
    }
  }

  walk(root);
  return segments;
}
