import type { EditorState } from "@tiptap/pm/state";
import type { ReorderGranularity, ReorderUnit } from "./types";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import { getCachedBunsetsuUnits, isJapanese } from "./bunsetsuSegmenter";
import { buildReorderUnits } from "./reorderUnits";
import { splitSentences } from "./sentenceSplit";

/**
 * 粒度と言語から paragraph の reorder units を解決する。
 * 英語の文節要求は文粒度へ、文節失敗時も文粒度へフォールバック。
 */
export function resolveUnitsForParagraph(
  state: EditorState,
  granularity: ReorderGranularity,
  language: string | undefined,
  bunsetsuOverride?: ReorderUnit[] | null,
): ReorderUnit[] | null {
  const resolved = resolveParagraphAtSelection(state);
  if (!resolved) return null;

  if (granularity === "character") {
    return buildReorderUnits(state, resolved, "character", language);
  }

  if (granularity === "bunsetsu" && isJapanese(language)) {
    const bunsetsu =
      bunsetsuOverride ?? getCachedBunsetsuUnits(state, language);
    const units = buildReorderUnits(
      state,
      resolved,
      "bunsetsu",
      language,
      bunsetsu,
    );
    if (units && units.length > 1) return units;
    // fallback
    const sentences = splitSentences(resolved.flat.text, language);
    return sentences.length > 0 ? sentences : null;
  }

  return buildReorderUnits(state, resolved, granularity, language);
}
