export const CODEX_SEMANTIC_LINK_MARK = "codexSemanticLink";

export interface CodexSemanticLink {
  entryId: string;
  /** Snapshot used only as a dangling-link fallback; live Codex names win. */
  label: string;
  text: string;
}

interface ProseMirrorMarkJson {
  type?: unknown;
  attrs?: unknown;
}

interface ProseMirrorNodeJson {
  type?: unknown;
  text?: unknown;
  attrs?: unknown;
  marks?: unknown;
  content?: unknown;
}

function asDocument(value: unknown): ProseMirrorNodeJson | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return asDocument(parsed);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object"
    ? (value as ProseMirrorNodeJson)
    : null;
}

function semanticMark(node: ProseMirrorNodeJson): {
  entryId: string;
  label: string;
} | null {
  if (!Array.isArray(node.marks)) return null;
  const mark = (node.marks as ProseMirrorMarkJson[]).find(
    (candidate) => candidate?.type === CODEX_SEMANTIC_LINK_MARK,
  );
  if (!mark?.attrs || typeof mark.attrs !== "object") return null;
  const attrs = mark.attrs as Record<string, unknown>;
  const entryId = typeof attrs.entryId === "string" ? attrs.entryId.trim() : "";
  if (!entryId) return null;
  const label = typeof attrs.label === "string" ? attrs.label.trim() : "";
  return { entryId, label };
}

/**
 * Extract author-declared span links from raw ProseMirror JSON.
 *
 * Adjacent text nodes carrying the same mark are coalesced so a bold/italic
 * split inside one linked phrase does not inflate occurrence counts. A
 * non-text node or block boundary ends the occurrence.
 */
export function extractCodexSemanticLinks(value: unknown): CodexSemanticLink[] {
  const doc = asDocument(value);
  if (!doc) return [];

  const links: CodexSemanticLink[] = [];
  let current: CodexSemanticLink | null = null;

  const flush = () => {
    if (current?.text.trim()) links.push(current);
    current = null;
  };

  const appendMarkedText = (
    mark: { entryId: string; label: string },
    text: string,
  ) => {
    if (!text) {
      flush();
      return;
    }
    if (current && current.entryId === mark.entryId) {
      current.text += text;
      // entryId defines semantic identity. If adjacent runs were saved before
      // and after a rename, retain the newest non-empty fallback label while
      // still treating the selected span as one occurrence.
      if (mark.label) current.label = mark.label;
      return;
    }
    flush();
    current = { ...mark, text };
  };

  const walk = (node: ProseMirrorNodeJson) => {
    if (node.type === "text") {
      const text = typeof node.text === "string" ? node.text : "";
      const mark = semanticMark(node);
      if (!mark || !text) {
        flush();
        return;
      }
      appendMarkedText(mark, text);
      return;
    }

    if (node.type === "ruby" || node.type === "mention") {
      const mark = semanticMark(node);
      const attrs = node.attrs as Record<string, unknown> | undefined;
      const rawText =
        node.type === "ruby"
          ? attrs?.base
          : `${attrs?.label || attrs?.id ? "@" : ""}${attrs?.label ?? attrs?.id ?? ""}`;
      const text = typeof rawText === "string" ? rawText : "";
      if (!mark || !text) {
        flush();
        return;
      }
      appendMarkedText(mark, text);
      return;
    }

    const children = Array.isArray(node.content)
      ? (node.content as ProseMirrorNodeJson[])
      : [];
    for (const child of children) {
      if (
        child?.type === "text" ||
        child?.type === "ruby" ||
        child?.type === "mention"
      ) {
        walk(child);
      } else {
        flush();
        if (child && typeof child === "object") walk(child);
        flush();
      }
    }
    // Each non-text container is a structural boundary. In normal PM JSON
    // this keeps separate paragraphs from being merged into one occurrence.
    flush();
  };

  walk(doc);
  flush();
  return links;
}

export function getCodexSemanticLinkEntryIds(value: unknown): string[] {
  return Array.from(
    new Set(extractCodexSemanticLinks(value).map((link) => link.entryId)),
  );
}
