import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * Export ruby nodes as HTML string.
 * Standard <ruby> tags are valid in both HTML and Markdown (inline HTML).
 */
export function rubyToHtml(node: ProseMirrorNode): string {
  const { base, annotation } = node.attrs as {
    base: string;
    annotation: string;
  };
  return `<ruby>${base}<rp>(</rp><rt>${annotation}</rt><rp>)</rp></ruby>`;
}

/**
 * Export ruby nodes as plain text with parenthesized reading.
 * e.g. "漢字(かんじ)"
 */
export function rubyToPlainText(node: ProseMirrorNode): string {
  const { base, annotation } = node.attrs as {
    base: string;
    annotation: string;
  };
  return `${base}(${annotation})`;
}

/**
 * Extract all ruby annotations from a document.
 * Useful for building a furigana glossary.
 */
export function extractRubyEntries(
  doc: ProseMirrorNode,
): Array<{ base: string; annotation: string }> {
  const entries: Array<{ base: string; annotation: string }> = [];
  doc.descendants((node) => {
    if (node.type.name === "ruby") {
      entries.push({
        base: node.attrs.base as string,
        annotation: node.attrs.annotation as string,
      });
    }
  });
  return entries;
}
