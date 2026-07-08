import type { ReorderUnit } from "./types";
import { isEnglishLanguage, splitSentences } from "./sentenceSplit";

/** UTF-16 code unit 半開区間で 1 語（非空白連続列）ずつ unit 化。 */
export function splitWordsEn(text: string): ReorderUnit[] {
  const units: ReorderUnit[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (i >= text.length) break;
    const from = i;
    while (i < text.length && !/\s/.test(text[i]!)) i += 1;
    units.push({ from, to: i, surface: text.slice(from, i) });
  }
  return units;
}

/** 言語・粒度に応じたトークン分割（word は英語のみ）。 */
export function splitTokens(
  text: string,
  granularity: "sentence" | "word",
  language: string | undefined,
): ReorderUnit[] {
  if (granularity === "word" && isEnglishLanguage(language)) {
    return splitWordsEn(text);
  }
  return splitSentences(text, language);
}

/**
 * 英語 word unit 連結時に区切り空白が必要か。
 * word は空白を含まないため、元テキストに無い場合は 1 空白を補う。
 */
export function needsEnglishWordGap(
  prev: ReorderUnit,
  next: ReorderUnit,
): boolean {
  const a = prev.surface;
  const b = next.surface;
  if (!a || !b) return false;
  if (/\s$/.test(a) || /^\s/.test(b)) return false;
  return true;
}
