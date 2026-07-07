import type { EditorState } from "@tiptap/pm/state";
import type { ReorderGranularity, ReorderUnit } from "./types";
import {
  pmPosToFlatOffset,
  resolveParagraphAtSelection,
} from "./paragraphFlat";
import { splitSentences } from "./sentenceSplit";
import { findUnitIndexAtFlatOffset } from "./reorderTransaction";

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

  let units: ReorderUnit[];
  if (granularity === "bunsetsu" && bunsetsuUnits && bunsetsuUnits.length > 0) {
    units = bunsetsuUnits;
  } else {
    units = splitSentences(resolved.flat.text, language);
  }

  if (units.length <= 1) return null;

  const caretFlatOffset = pmPosToFlatOffset(
    resolved.flat,
    state.selection.from,
  );
  const unitIndex = findUnitIndexAtFlatOffset(units, caretFlatOffset);
  return { resolved, units, unitIndex, caretFlatOffset };
}
