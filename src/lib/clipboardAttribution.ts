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

  // Case 2: Editor body copy (span[data-authorship])
  const authorshipSpans = doc.querySelectorAll("span[data-authorship]");
  if (authorshipSpans.length > 0) {
    const segments: AttributedSegment[] = [];
    for (const span of authorshipSpans) {
      const text = span.textContent ?? "";
      if (!text) continue;
      const source = (span.getAttribute("data-authorship") ??
        "unknown") as AuthorshipSource;
      // Merge adjacent segments with same source
      const last = segments[segments.length - 1];
      if (last && last.source === source) {
        last.text += text;
      } else {
        segments.push({ text, source });
      }
    }
    if (segments.length > 0) return segments;
  }

  // Case 3: Check for text nodes outside authorship spans (mixed editor copy)
  // When editor content has both marked and unmarked text, unmarked text
  // appears as bare text nodes without data-authorship spans.
  // Walk the body to capture all text with correct attribution.
  const body = doc.body;
  if (body.querySelector("span[data-authorship]")) {
    // We already handled pure-authorship case above; this branch handles mixed content
    const segments = extractMixedSegments(body);
    if (segments.length > 0) return segments;
  }

  return null;
}

/**
 * Walk DOM nodes to extract text with attribution, handling mixed
 * marked/unmarked content from editor copy.
 */
function extractMixedSegments(root: Element): AttributedSegment[] {
  const segments: AttributedSegment[] = [];

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text) return;
      // Check if this text node is inside an authorship span
      const parentSpan = (node.parentElement as Element | null)?.closest?.(
        "span[data-authorship]",
      );
      const source: AuthorshipSource = parentSpan
        ? ((parentSpan.getAttribute("data-authorship") ??
            "unknown") as AuthorshipSource)
        : "human";

      const last = segments[segments.length - 1];
      if (last && last.source === source) {
        last.text += text;
      } else {
        segments.push({ text, source });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      for (const child of node.childNodes) {
        walk(child);
      }
    }
  }

  walk(root);
  return segments;
}
