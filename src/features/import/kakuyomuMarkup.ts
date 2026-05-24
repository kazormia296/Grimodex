/**
 * Kakuyomu body markup → ProseMirror JSON.
 *
 * Handles Kakuyomu-specific notation:
 * - `｜base《reading》` / `kanji《reading》` (auto-ruby on trailing kanji)
 * - `《《text》》` emphasis dots
 * - Full-width indent (U+3000) preserved in paragraph text
 */

const KANJI_RE = /[一-鿿々〆〤]/;

type InlineNode =
  | { type: "text"; text: string; marks?: { type: string }[] }
  | { type: "ruby"; attrs: { base: string; annotation: string } };

/** Kakuyomu notation text → ProseMirror JSON string. */
export function kakuyomuBodyToProseMirror(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = trimTrailingWhitespaceLines(normalized);
  if (!trimmed.trim()) {
    return JSON.stringify({ type: "doc", content: [] });
  }

  const blocks = splitParagraphBlocks(trimmed);
  const content = blocks.map((block) => ({
    type: "paragraph",
    content: block.length > 0 ? block : undefined,
  }));

  return JSON.stringify({ type: "doc", content });
}

function trimTrailingWhitespaceLines(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function splitParagraphBlocks(text: string): InlineNode[][] {
  const lines = text.split("\n");
  const blocks: InlineNode[][] = [];
  let currentLines: string[] = [];

  function flush(): void {
    if (currentLines.length === 0) return;
    const joined = currentLines.join("\n");
    blocks.push(parseInlineLine(joined));
    currentLines = [];
  }

  for (const line of lines) {
    if (line.trim() === "") {
      flush();
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return blocks;
}

function parseInlineLine(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;

  while (i < text.length) {
    // Emphasis dots: 《《text》》 (innermost pair when nested)
    if (text.startsWith("《《", i)) {
      const match = findInnermostEmphasisDots(text, i);
      if (match) {
        if (match.inner.length > 0) {
          nodes.push({
            type: "text",
            text: match.inner,
            marks: [{ type: "emphasisDots" }],
          });
        }
        i = match.nextIndex;
        continue;
      }
    }

    // Pipe ruby: ｜base《reading》
    if (text[i] === "｜") {
      const ruby = tryParsePipeRuby(text, i);
      if (ruby) {
        nodes.push(ruby.node);
        i = ruby.nextIndex;
        continue;
      }
    }

    // Auto ruby: kanji《reading》 (base = contiguous kanji immediately before 《)
    if (text[i] === "《") {
      const ruby = tryParseAutoRuby(text, i);
      if (ruby) {
        trimSuffixFromLastText(
          nodes,
          (ruby.node as Extract<InlineNode, { type: "ruby" }>).attrs.base,
        );
        nodes.push(ruby.node);
        i = ruby.nextIndex;
        continue;
      }
      appendText(nodes, "《");
      i++;
      continue;
    }

    // Literal run until next special token
    const nextSpecial = findNextSpecialIndex(text, i);
    const literal = text.slice(i, nextSpecial);
    if (literal) {
      appendText(nodes, literal);
    }
    i = nextSpecial === i ? i + 1 : nextSpecial;
  }

  return nodes;
}

function findInnermostEmphasisDots(
  text: string,
  start: number,
): { inner: string; nextIndex: number } | null {
  let searchFrom = start;
  while (searchFrom < text.length) {
    const open = text.indexOf("《《", searchFrom);
    if (open === -1) return null;
    const innerStart = open + 2;
    const nested = text.indexOf("《《", innerStart);
    const close = text.indexOf("》》", innerStart);
    if (close === -1) return null;
    if (nested !== -1 && nested < close) {
      searchFrom = nested;
      continue;
    }
    const inner = text.slice(innerStart, close);
    if (!inner.includes("《《")) {
      return { inner, nextIndex: close + 2 };
    }
    searchFrom = open + 2;
  }
  return null;
}

function findNextSpecialIndex(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text.startsWith("《《", i)) return i;
    if (text[i] === "｜") return i;
    if (text[i] === "《") return i;
    i++;
  }
  return text.length;
}

function tryParsePipeRuby(
  text: string,
  pipeIndex: number,
): { node: InlineNode; nextIndex: number } | null {
  const open = text.indexOf("《", pipeIndex + 1);
  if (open === -1) return null;
  const close = text.indexOf("》", open + 1);
  if (close === -1) return null;
  const base = text.slice(pipeIndex + 1, open);
  const annotation = text.slice(open + 1, close);
  if (!base || !annotation) return null;
  return {
    node: { type: "ruby", attrs: { base, annotation } },
    nextIndex: close + 1,
  };
}

function tryParseAutoRuby(
  text: string,
  openIndex: number,
): { node: InlineNode; nextIndex: number } | null {
  const close = text.indexOf("》", openIndex + 1);
  if (close === -1) return null;
  const annotation = text.slice(openIndex + 1, close);
  if (!annotation) return null;

  let kanjiStart = openIndex - 1;
  while (kanjiStart >= 0 && KANJI_RE.test(text[kanjiStart]!)) {
    kanjiStart--;
  }
  kanjiStart++;

  const base = text.slice(kanjiStart, openIndex);
  if (!base || !KANJI_RE.test(base[0]!)) return null;

  return {
    node: { type: "ruby", attrs: { base, annotation } },
    nextIndex: close + 1,
  };
}

function appendText(nodes: InlineNode[], text: string): void {
  if (!text) return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === "text" && !last.marks?.length) {
    last.text += text;
  } else {
    nodes.push({ type: "text", text });
  }
}

function trimSuffixFromLastText(nodes: InlineNode[], suffix: string): void {
  if (!suffix) return;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (node.type !== "text" || node.marks?.length) continue;
    if (node.text.endsWith(suffix)) {
      node.text = node.text.slice(0, -suffix.length);
      if (!node.text) nodes.splice(i, 1);
      return;
    }
    return;
  }
}

/** Split Kakuyomu 【section】 formatted text into key→value map. */
export function parseKakuyomuSections(text: string): Map<string, string> {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");
  const sections = new Map<string, string>();
  let currentKey: string | null = null;
  let valueLines: string[] = [];

  function flush(): void {
    if (currentKey === null) return;
    sections.set(currentKey, valueLines.join("\n").trimEnd());
    valueLines = [];
  }

  for (const line of lines) {
    const m = /^【([^】]+)】$/.exec(line);
    if (m) {
      flush();
      currentKey = m[1]!;
      continue;
    }
    if (currentKey !== null) {
      valueLines.push(line);
    }
  }
  flush();
  return sections;
}

/** Extract body text from episode sections (matches 【本文（N行）】). */
export function extractEpisodeBody(sections: Map<string, string>): string {
  for (const [key, value] of sections) {
    if (key.startsWith("本文")) {
      return trimTrailingWhitespaceLines(value.replace(/\r\n/g, "\n"));
    }
  }
  return "";
}

/** Parse bullet list lines (`- item`) from a section value. */
export function parseBulletList(value: string): string[] {
  return value
    .split("\n")
    .map((l) => /^-\s+(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!.trim());
}
