import { Slice } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type {
  CodexInlineReorderInfo,
  RangeSegmentMap,
  ReorderGranularity,
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
import { isEnglishLanguage } from "./sentenceSplit";
import { needsEnglishUnitGap } from "./englishUnitGap";

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
  language?: string,
  granularity: ReorderGranularity = "sentence",
): number {
  let newOffset = 0;
  let prevInOrder: number | null = null;

  for (const unitIdx of order) {
    const u = units[unitIdx]!;
    const gap =
      prevInOrder !== null &&
      needsEnglishUnitGap(units[prevInOrder]!, u, granularity, language)
        ? 1
        : 0;
    const unitStart = newOffset + gap;
    const unitLen = u.to - u.from;

    if (caretFlatOffset >= u.from && caretFlatOffset < u.to) {
      return unitStart + (caretFlatOffset - u.from);
    }

    newOffset = unitStart + unitLen;
    prevInOrder = unitIdx;
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
  /**
   * 範囲選択オーバーライドの flat 区間。指定時は、その unit の移動後 PM 範囲へ
   * TextSelection を張り直して選択を維持する（選択が解除されると次回 build で
   * override が消え、移動先で前後 unit と融合してしまうのを防ぐ）。
   */
  selectionFlatRange?: { from: number; to: number },
  language?: string,
  granularity: ReorderGranularity = "sentence",
): ParagraphReorderResult | null {
  if (units.length <= 1) return null;
  if (!isValidPermutation(order, units.length)) return null;

  const lang = language;
  const gran = granularity;
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
    lang,
    gran,
  );

  const tr2 = tr.replace(
    resolved.contentFrom,
    resolved.contentTo,
    new Slice(combined, 0, 0),
  );

  const newNode = tr2.doc.nodeAt(resolved.pos);
  if (!newNode || newNode.type.name !== "paragraph") return null;

  const newFlat = flattenParagraph(newNode, resolved.contentFrom);

  const selUnitIdx =
    selectionFlatRange !== undefined
      ? units.findIndex(
          (u) =>
            u.from === selectionFlatRange.from &&
            u.to === selectionFlatRange.to,
        )
      : -1;
  let selNewPm: { from: number; to: number } | null = null;

  const enGap = isEnglishLanguage(lang);
  let newFlatCursor = 0;
  let prevInOrder: number | null = null;
  const segments: RangeSegmentMap[] = [];
  for (const unitIdx of order) {
    const u = units[unitIdx]!;
    if (
      prevInOrder !== null &&
      enGap &&
      needsEnglishUnitGap(units[prevInOrder]!, u, gran, lang)
    ) {
      newFlatCursor += 1;
    }
    const len = u.to - u.from;
    const newPm = flatRangeToPm(newFlat, newFlatCursor, newFlatCursor + len);
    const oldPm = pmRanges[unitIdx]!;
    segments.push({
      oldFrom: oldPm.from,
      oldTo: oldPm.to,
      newFrom: newPm.from,
      newTo: newPm.to,
    });
    if (unitIdx === selUnitIdx) selNewPm = newPm;
    newFlatCursor += len;
    prevInOrder = unitIdx;
  }

  const reorderMeta: CodexInlineReorderInfo = {
    kind: "inlinePermutation",
    segments,
  };
  tr2.setMeta("codexHighlightReorder", reorderMeta);

  if (selNewPm) {
    // 選択オーバーライド unit を移動後の位置で選択し直す（範囲維持）。
    tr2.setSelection(TextSelection.create(tr2.doc, selNewPm.from, selNewPm.to));
  } else if (caretFlatOffset !== undefined) {
    const newFlatOffset = mapFlatOffsetThroughPermutation(
      units,
      order,
      caretFlatOffset,
      lang,
      gran,
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
  selectionFlatRange?: { from: number; to: number },
  language?: string,
  granularity: ReorderGranularity = "sentence",
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
    selectionFlatRange,
    language,
    granularity,
  );
}

/** 現在キャレットが属する unit index。 */
export function findUnitIndexAtFlatOffset(
  units: ReorderUnit[],
  flatOffset: number,
): number {
  if (units.length === 0) return 0;

  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (flatOffset >= u.from && flatOffset < u.to) return i;
  }

  // 語/文の終端直後（unit 間の空白など）: 直前 unit に属する。
  // word 粒度では PM キャレットが `u.to`（空白位置）に来ることが多い。
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    if (flatOffset >= u.from) return i;
  }
  return 0;
}
