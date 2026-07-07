import type { EditorState } from "@tiptap/pm/state";
import type { ReorderGranularity, ReorderUnit } from "./types";
import { splitSentences } from "./sentenceSplit";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import { getCachedBunsetsuUnits } from "./bunsetsuSegmenter";

function isJapanese(language: string | undefined): boolean {
  return !(language ?? "ja").toLowerCase().startsWith("en");
}

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

  if (granularity === "bunsetsu" && isJapanese(language)) {
    const bunsetsu =
      bunsetsuOverride ?? getCachedBunsetsuUnits(state, language);
    if (bunsetsu && bunsetsu.length > 1) return bunsetsu;
    // fallback
  }

  const sentences = splitSentences(resolved.flat.text, language);
  return sentences.length > 0 ? sentences : null;
}
