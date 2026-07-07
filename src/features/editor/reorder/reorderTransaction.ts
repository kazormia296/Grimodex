import { Slice } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type {
  CodexInlineReorderInfo,
  RangeSegmentMap,
  ReorderUnit,
} from "./types";
import {
  flatRangeToPm,
  flattenParagraph,
  pmPosToFlatOffset,
  type ResolvedParagraph,
} from "./paragraphFlat";
import {
  buildPermutedParagraphContent,
  collectPreservedInlines,
  unitPmRangesFor,
} from "./paragraphPreserved";

function isValidPermutation(order: number[], length: number): boolean {
  if (order.length !== length) return false;
  const seen = new Set(order);
  return seen.size === length && [...seen].every((i) => i >= 0 && i < length);
}

/** キャレット flat offset を permutation 後の flat offset へ変換。 */
export function mapFlatOffsetThroughPermutation(
  units: ReorderUnit[],
  order: number[],
  caretFlatOffset: number,
): number {
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (caretFlatOffset >= u.from && caretFlatOffset < u.to) {
      const offsetInUnit = caretFlatOffset - u.from;
      let newOffset = 0;
      for (const idx of order) {
        if (idx === i) {
          return newOffset + offsetInUnit;
        }
        newOffset += units[idx]!.to - units[idx]!.from;
      }
    }
  }
  return caretFlatOffset;
}

export interface ParagraphReorderResult {
  tr: Transaction;
  segments: RangeSegmentMap[];
}

/**
 * 段落内 unit を `order` 順に並べ替える transaction を構築する。
 * marks 込み Slice を保持し、Codex inline permutation meta を積む。
 */
export function buildParagraphReorderTransaction(
  state: EditorState,
  resolved: ResolvedParagraph,
  units: ReorderUnit[],
  order: number[],
  caretFlatOffset?: number,
  transaction?: Transaction,
): ParagraphReorderResult | null {
  if (units.length <= 1) return null;
  if (!isValidPermutation(order, units.length)) return null;

  const tr = transaction ?? state.tr;
  const doc = tr.doc;

  const pmRanges = unitPmRangesFor(resolved.flat, units);
  const slices = units.map((u) => {
    const pm = flatRangeToPm(resolved.flat, u.from, u.to);
    return doc.slice(pm.from, pm.to);
  });

  const preserved = collectPreservedInlines(
    doc,
    resolved.contentFrom,
    resolved.contentTo,
    resolved.flat,
    pmRanges,
  );
  const combined = buildPermutedParagraphContent(
    doc,
    units,
    order,
    slices,
    preserved,
  );

  const tr2 = tr.replace(
    resolved.contentFrom,
    resolved.contentTo,
    new Slice(combined, 0, 0),
  );

  const newNode = tr2.doc.nodeAt(resolved.pos);
  if (!newNode || newNode.type.name !== "paragraph") return null;

  const newFlat = flattenParagraph(newNode, resolved.contentFrom);

  let newFlatCursor = 0;
  const segments: RangeSegmentMap[] = [];
  for (const unitIdx of order) {
    const u = units[unitIdx]!;
    const len = u.to - u.from;
    const newPm = flatRangeToPm(newFlat, newFlatCursor, newFlatCursor + len);
    const oldPm = pmRanges[unitIdx]!;
    segments.push({
      oldFrom: oldPm.from,
      oldTo: oldPm.to,
      newFrom: newPm.from,
      newTo: newPm.to,
    });
    newFlatCursor += len;
  }

  const reorderMeta: CodexInlineReorderInfo = {
    kind: "inlinePermutation",
    segments,
  };
  tr2.setMeta("codexHighlightReorder", reorderMeta);

  if (caretFlatOffset !== undefined) {
    const newFlatOffset = mapFlatOffsetThroughPermutation(
      units,
      order,
      caretFlatOffset,
    );
    const caretPm = flatRangeToPm(
      newFlat,
      Math.min(newFlatOffset, Math.max(0, newFlat.text.length - 1)),
      Math.min(newFlatOffset + 1, newFlat.text.length),
    ).from;
    tr2.setSelection(TextSelection.near(tr2.doc.resolve(caretPm)));
  }

  return { tr: tr2, segments };
}

/** 隣接 unit swap（order は identity に近い 1 回 swap）。 */
export function buildAdjacentUnitSwapTransaction(
  state: EditorState,
  resolved: ResolvedParagraph,
  units: ReorderUnit[],
  unitIndex: number,
  dir: -1 | 1,
  transaction?: Transaction,
): ParagraphReorderResult | null {
  const target = unitIndex + dir;
  if (target < 0 || target >= units.length) return null;
  const order = units.map((_, i) => i);
  order[unitIndex] = target;
  order[target] = unitIndex;

  const caretFlat = pmPosToFlatOffset(resolved.flat, state.selection.from);
  return buildParagraphReorderTransaction(
    state,
    resolved,
    units,
    order,
    caretFlat,
    transaction,
  );
}

/** 現在キャレットが属する unit index。 */
export function findUnitIndexAtFlatOffset(
  units: ReorderUnit[],
  flatOffset: number,
): number {
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (flatOffset >= u.from && flatOffset < u.to) return i;
  }
  return Math.max(0, units.length - 1);
}
