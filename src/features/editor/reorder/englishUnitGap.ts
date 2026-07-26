import type { ReorderGranularity, ReorderUnit } from "./types";
import { isEnglishLanguage, needsEnglishSentenceGap } from "./sentenceSplit";
import { needsEnglishPhraseGap } from "./phraseSplit";
import { needsEnglishWordGap } from "./wordSplit";

/** 英語の sentence/phrase/word 並べ替え連結時に区切り空白を補うか。 */
export function needsEnglishUnitGap(
  prev: ReorderUnit,
  next: ReorderUnit,
  granularity: ReorderGranularity,
  language?: string,
): boolean {
  if (!isEnglishLanguage(language)) return false;
  if (granularity === "word") return needsEnglishWordGap(prev, next);
  if (granularity === "phrase") return needsEnglishPhraseGap(prev, next);
  if (granularity === "sentence") return needsEnglishSentenceGap(prev, next);
  return false;
}
