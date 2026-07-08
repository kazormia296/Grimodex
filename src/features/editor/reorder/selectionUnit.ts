import type { EditorState } from "@tiptap/pm/state";
import type { ReorderGranularity, ReorderUnit } from "./types";
import {
  pmPosToFlatOffset,
  resolveParagraphAtSelection,
} from "./paragraphFlat";
import { findUnitIndexAtFlatOffset } from "./reorderTransaction";
import { buildReorderUnits } from "./reorderUnits";
import { getCachedBunsetsuUnits } from "./bunsetsuSegmenter";

export interface SelectionUnitContext {
  resolved: NonNullable<ReturnType<typeof resolveParagraphAtSelection>>;
  units: ReorderUnit[];
  unitIndex: number;
  caretFlatOffset: number;
}

export interface ParagraphSelectionContext {
  resolved: NonNullable<ReturnType<typeof resolveParagraphAtSelection>>;
  caretFlatOffset: number;
}

/** 選択位置の paragraph と caret の flat offset のみ解決（unit 数は問わない）。 */
export function resolveParagraphSelectionContext(
  state: EditorState,
): ParagraphSelectionContext | null {
  const resolved = resolveParagraphAtSelection(state);
  if (!resolved) return null;
  const caretFlatOffset = pmPosToFlatOffset(
    resolved.flat,
    state.selection.from,
  );
  return { resolved, caretFlatOffset };
}

/** 現在選択から paragraph + unit 文脈を解決。 */
export function resolveSelectionUnits(
  state: EditorState,
  granularity: ReorderGranularity,
  language: string | undefined,
  bunsetsuUnits?: ReorderUnit[] | null,
): SelectionUnitContext | null {
  const resolved = resolveParagraphAtSelection(state);
  if (!resolved) return null;

  let units = buildReorderUnits(
    state,
    resolved,
    granularity,
    language,
    bunsetsuUnits ??
      (granularity === "bunsetsu"
        ? getCachedBunsetsuUnits(state, language)
        : null),
  );
  // キーボード swap 等: 文節 cache miss 時は文粒度へ（旧 resolveSelectionUnits 互換）。
  if ((!units || units.length <= 1) && granularity === "bunsetsu") {
    units = buildReorderUnits(state, resolved, "sentence", language);
  }
  if (!units || units.length <= 1) return null;

  const caretFlatOffset = pmPosToFlatOffset(
    resolved.flat,
    state.selection.from,
  );
  const unitIndex = findUnitIndexAtFlatOffset(units, caretFlatOffset);
  return { resolved, units, unitIndex, caretFlatOffset };
}
