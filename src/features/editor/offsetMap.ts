/**
 * Scene-wide UTF-16 ↔ ProseMirror position map.
 *
 * Shared utility consumed by the Linter (squiggly ranges, Fix application)
 * and — in the future — PostEffects annotations. The scene-wide string
 * concept is: concatenate each lint-supported block's plain text, joined
 * with a `\n` between blocks. That matches the design document's
 * "paragraph 終端 = \n" serialization rule.
 *
 * Code blocks, images, and horizontal rules are skipped entirely (no
 * block entry is emitted, no interval is created). Ruby nodes contribute
 * their base text only — ふりがな (rt) is excluded.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export type LintBlockKind =
  | "paragraph"
  | "heading"
  | "blockquote"
  | "listItem"
  | "tableCell";

/**
 * Plain-text slice suitable for sending to the Rust linter. `text` is the
 * block's concatenated content; `strOffsetStart` is the scene-wide UTF-16
 * offset at which `text` begins.
 */
export interface LintBlock {
  id: number;
  kind: LintBlockKind;
  text: string;
  strOffsetStart: number;
}

/**
 * Mapping interval for scene-wide UTF-16 offsets back to ProseMirror
 * positions. Each text node produces one interval; block-terminator
 * newlines are tracked implicitly by consecutive intervals that belong
 * to different blocks.
 */
export interface PosInterval {
  pmPosStart: number;
  strOffsetStart: number;
  /** UTF-16 code units covered by this interval. */
  length: number;
  blockId: number;
  blockKind: LintBlockKind;
}

/**
 * One disable directive extracted from the doc. Shape matches the wire
 * format sent to Rust (`DisableDirective`). Mark-based inline spans and
 * block-level `lintDisabled` attributes both land in this list — Rust
 * doesn't care which UI control produced them.
 */
export interface OffsetMapDisable {
  rules: string[];
  range: { start: number; end: number };
}

export interface SceneOffsetMap {
  blocks: LintBlock[];
  intervals: PosInterval[];
  /**
   * Disable directives collected during the same doc walk. The list is
   * unsorted; consumers that need stable order sort before hashing.
   */
  disables: OffsetMapDisable[];
  /** Total UTF-16 length of the scene-wide text (sum of block texts + separators). */
  totalLength: number;
}

const BLOCK_KIND_MAP: Record<string, LintBlockKind | undefined> = {
  paragraph: "paragraph",
  heading: "heading",
  blockquote: "blockquote",
  listItem: "listItem",
  tableCell: "tableCell",
};

const SKIP_NODE_TYPES = new Set(["codeBlock", "image", "horizontalRule"]);

/**
 * Build a scene-wide offset map from a ProseMirror document.
 */
export function buildOffsetMap(doc: ProseMirrorNode): SceneOffsetMap {
  const blocks: LintBlock[] = [];
  const intervals: PosInterval[] = [];
  const disables: OffsetMapDisable[] = [];

  // Running scene-wide UTF-16 offset. Blocks are joined by "\n", so between
  // two blocks we advance by 1 additional unit.
  let sceneCursor = 0;
  let nextBlockId = 0;

  function visit(node: ProseMirrorNode, pos: number) {
    const typeName = node.type.name;

    if (SKIP_NODE_TYPES.has(typeName)) return;

    const mappedKind = BLOCK_KIND_MAP[typeName];
    if (mappedKind) {
      // Start a new block. Advance the scene cursor by 1 for the block
      // separator if this is not the first block.
      if (blocks.length > 0) sceneCursor += 1;

      const blockId = nextBlockId++;
      const blockStart = sceneCursor;
      const textParts: string[] = [];

      // Walk this block's children to collect text. Skip nested blocks
      // — nested blocks (e.g. listItem → paragraph) will be visited as
      // their own entries via the outer walker.
      //
      // For listItem / tableCell the common pattern is that children are
      // paragraphs; in that case we don't want listItem to capture their
      // text separately. The simplest rule: if a block has any child that
      // is itself a block kind, this block emits no text of its own and
      // acts as a passthrough. Otherwise, collect children's text.
      let hasNestedBlock = false;
      node.forEach((child) => {
        if (BLOCK_KIND_MAP[child.type.name]) hasNestedBlock = true;
      });

      if (hasNestedBlock) {
        // Roll back the separator we added — we're a passthrough, nested
        // blocks handle their own offsets. Resetting `blocks.length > 0`
        // is awkward, so track the not-yet-committed state.
        if (blocks.length > 0) sceneCursor -= 1;
        // Recurse into children (they will emit their own blocks).
        node.forEach((child, offset) => {
          visit(child, pos + 1 + offset);
        });
        nextBlockId -= 1; // reclaim unused id
        return;
      }

      // Leaf block — collect text nodes (and ruby base text) into one
      // continuous string and emit intervals.
      collectLeafBlock(
        node,
        pos,
        blockId,
        mappedKind,
        blockStart,
        textParts,
        intervals,
        disables,
      );

      const blockText = textParts.join("");
      blocks.push({
        id: blockId,
        kind: mappedKind,
        text: blockText,
        strOffsetStart: blockStart,
      });
      sceneCursor = blockStart + utf16Length(blockText);

      // Block-level disable from node attribute. Emit only when the
      // block has non-empty text — a block with `lintDisabled` on an
      // empty paragraph has nothing to silence.
      const blockDisabled = sanitiseRules(node.attrs.lintDisabled);
      if (blockDisabled && blockText.length > 0) {
        disables.push({
          rules: blockDisabled,
          range: {
            start: blockStart,
            end: blockStart + utf16Length(blockText),
          },
        });
      }
      return;
    }

    // Not a block kind itself — descend into children.
    node.forEach((child, offset) => {
      visit(child, pos + 1 + offset);
    });
  }

  doc.forEach((child, offset) => {
    visit(child, offset);
  });

  return { blocks, intervals, disables, totalLength: sceneCursor };
}

function collectLeafBlock(
  node: ProseMirrorNode,
  blockPos: number,
  blockId: number,
  blockKind: LintBlockKind,
  blockStart: number,
  textParts: string[],
  intervals: PosInterval[],
  disables: OffsetMapDisable[],
) {
  // Running UTF-16 offset inside this block.
  let inBlockOffset = 0;
  // Accumulator for inline `lintDisable` Mark runs. Adjacent text nodes
  // that carry the same `rules` set are merged into one directive so a
  // diagnostic straddling the boundary between two text segments still
  // gets silenced.
  let currentRun: {
    rules: string[];
    start: number;
    end: number;
  } | null = null;

  const flushRun = () => {
    if (currentRun) {
      disables.push({
        rules: currentRun.rules,
        range: { start: currentRun.start, end: currentRun.end },
      });
      currentRun = null;
    }
  };

  const extendOrStart = (
    rules: string[],
    sceneStart: number,
    sceneEnd: number,
  ) => {
    if (
      currentRun &&
      currentRun.end === sceneStart &&
      sameRules(currentRun.rules, rules)
    ) {
      currentRun.end = sceneEnd;
    } else {
      flushRun();
      currentRun = { rules, start: sceneStart, end: sceneEnd };
    }
  };

  node.descendants((child, posWithinParent) => {
    if (child.type.name === "ruby") {
      const base = (child.attrs.base as string | undefined) ?? "";
      if (base.length === 0) return false;
      flushRun();
      // Atom node — the whole base maps to the atom's PM position. Use
      // one interval for the full base text.
      intervals.push({
        pmPosStart: blockPos + 1 + posWithinParent,
        strOffsetStart: blockStart + inBlockOffset,
        length: utf16Length(base),
        blockId,
        blockKind,
      });
      textParts.push(base);
      inBlockOffset += utf16Length(base);
      return false;
    }

    if (child.type.name === "hardBreak") {
      flushRun();
      // hardBreak serialises to \n in plain text.
      intervals.push({
        pmPosStart: blockPos + 1 + posWithinParent,
        strOffsetStart: blockStart + inBlockOffset,
        length: 1,
        blockId,
        blockKind,
      });
      textParts.push("\n");
      inBlockOffset += 1;
      return false;
    }

    if (child.isText) {
      const text = child.text ?? "";
      const len = utf16Length(text);
      if (len > 0) {
        intervals.push({
          pmPosStart: blockPos + 1 + posWithinParent,
          strOffsetStart: blockStart + inBlockOffset,
          length: len,
          blockId,
          blockKind,
        });
        textParts.push(text);
        const sceneStart = blockStart + inBlockOffset;
        const sceneEnd = sceneStart + len;
        const markRules = findLintDisableRules(child);
        if (markRules) {
          extendOrStart(markRules, sceneStart, sceneEnd);
        } else {
          flushRun();
        }
        inBlockOffset += len;
      } else {
        flushRun();
      }
      return false;
    }
    // continue descending
    return undefined;
  });

  flushRun();
}

function findLintDisableRules(textNode: ProseMirrorNode): string[] | null {
  for (const mark of textNode.marks) {
    if (mark.type.name !== "lintDisable") continue;
    return sanitiseRules(mark.attrs.rules);
  }
  return null;
}

/**
 * Normalise a rules input (from TipTap attrs) into a non-empty
 * `string[]`. Returns `null` when the input is not a valid selector
 * payload — the caller drops the directive in that case, matching the
 * engine's behaviour where invalid selectors are skipped with a
 * warning.
 */
function sanitiseRules(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return null;
  if (!raw.every((s) => typeof s === "string")) return null;
  return raw as string[];
}

function sameRules(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function utf16Length(s: string): number {
  return s.length;
}

/**
 * Convert a scene-wide UTF-16 offset into a ProseMirror position.
 *
 * Returns `null` if the offset lies in a block separator (between blocks)
 * or outside the scene range — callers should clamp to the nearest block
 * boundary if that happens.
 */
/**
 * Inverse of `strOffsetToPmPos`: ProseMirror position → scene-wide UTF-16
 * offset. Returns `null` if `pmPos` is not inside any mapped interval (i.e.
 * on a node boundary or in a skipped block).
 */
export function pmPosToStrOffset(
  map: SceneOffsetMap,
  pmPos: number,
): number | null {
  // Intervals are sorted by pmPosStart. Binary search.
  if (map.intervals.length === 0) return null;
  let lo = 0;
  let hi = map.intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const it = map.intervals[mid];
    if (pmPos < it.pmPosStart) {
      hi = mid - 1;
    } else if (pmPos > it.pmPosStart + it.length) {
      lo = mid + 1;
    } else {
      const local = pmPos - it.pmPosStart;
      return it.strOffsetStart + local;
    }
  }
  return null;
}

export function strOffsetToPmPos(
  map: SceneOffsetMap,
  offset: number,
): number | null {
  if (map.intervals.length === 0) return null;
  // Binary search for the interval whose [strOffsetStart, +length) contains `offset`.
  let lo = 0;
  let hi = map.intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const it = map.intervals[mid];
    if (offset < it.strOffsetStart) {
      hi = mid - 1;
    } else if (offset >= it.strOffsetStart + it.length) {
      lo = mid + 1;
    } else {
      const local = offset - it.strOffsetStart;
      return it.pmPosStart + local;
    }
  }
  // Not found — offset is either past end or in a separator. If it sits
  // exactly at the end of some interval, clamp to that interval's end.
  for (let i = map.intervals.length - 1; i >= 0; i--) {
    const it = map.intervals[i];
    if (offset === it.strOffsetStart + it.length) {
      return it.pmPosStart + it.length;
    }
  }
  return null;
}
