import type { EditorState } from "@tiptap/pm/state";
import type { ReorderGranularity, ReorderUnit } from "./types";
import {
  resolveParagraphAtPos,
  resolveParagraphAtSelection,
  type ResolvedParagraph,
} from "./paragraphFlat";
import { buildReorderUnits } from "./reorderUnits";
import { identityOrder, swapSlots } from "./reorderPermutation";
import { isEnglishLanguage } from "./sentenceSplit";

/** Alt+Shift 中に phrase/word の境界を固定するスナップショット（ドラッグの units0 と同型）。 */
export interface SegmentFreezeState {
  blockPos: number;
  units0: ReorderUnit[];
  order: number[];
}

/** 英語 phrase/word は swap 途中の再セグメントで境界が化けるため固定対象。 */
export function shouldFreezeSegment(
  granularity: ReorderGranularity,
  language: string | undefined,
): boolean {
  if (!isEnglishLanguage(language)) return false;
  return granularity === "phrase" || granularity === "word";
}

function captureAtResolved(
  resolved: NonNullable<ReturnType<typeof resolveParagraphAtSelection>>,
  state: EditorState,
  granularity: ReorderGranularity,
  language: string | undefined,
): SegmentFreezeState | null {
  const units = buildReorderUnits(state, resolved, granularity, language);
  if (!units || units.length <= 1) return null;
  return {
    blockPos: resolved.pos,
    units0: units,
    order: identityOrder(units.length),
  };
}

/** 現在の選択段落から freeze を採取（altShift 突入・段落移動時）。 */
export function captureSegmentFreeze(
  state: EditorState,
  granularity: ReorderGranularity,
  language: string | undefined,
): SegmentFreezeState | null {
  if (!shouldFreezeSegment(granularity, language)) return null;
  const resolved = resolveParagraphAtSelection(state);
  if (!resolved) return null;
  return captureAtResolved(resolved, state, granularity, language);
}

/** 任意 blockPos から freeze を採取（ドラッグ開始など）。 */
export function captureSegmentFreezeAtPos(
  state: EditorState,
  blockPos: number,
  granularity: ReorderGranularity,
  language: string | undefined,
): SegmentFreezeState | null {
  if (!shouldFreezeSegment(granularity, language)) return null;
  const resolved = resolveParagraphAtPos(state, blockPos);
  if (!resolved) return null;
  return captureAtResolved(resolved, state, granularity, language);
}

/** 隣接 swap 後の freeze（order 更新）。freeze 未設定時は ctx.units を units0 として新設。 */
export function nextFreezeAfterAdjacentSwap(
  freeze: SegmentFreezeState | null,
  resolved: ResolvedParagraph,
  units: ReorderUnit[],
  unitIndex: number,
  dir: -1 | 1,
  granularity: ReorderGranularity,
  language: string | undefined,
): SegmentFreezeState | null {
  if (!shouldFreezeSegment(granularity, language)) return freeze;
  const baseOrder = freeze?.order ?? identityOrder(units.length);
  const target = unitIndex + dir;
  if (target < 0 || target >= baseOrder.length) return freeze;
  const nextOrder = swapSlots(baseOrder, unitIndex, target);
  return {
    blockPos: resolved.pos,
    units0: freeze?.units0 ?? units,
    order: nextOrder,
  };
}
