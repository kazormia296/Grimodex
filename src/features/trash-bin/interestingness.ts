import type { TrashSpan, TrashSubKind } from "./types";

/**
 * 文字屑が「光る」(`isInteresting === true`) かを判定する純関数。
 * 設計書 v3 §3.3 の文字屑ルール:
 *  1. spans に `source === "ai"` が 1 つでもあれば true
 *  2. 全体テキストが INTERESTING_MIN_CHARS 文字以上 → true
 *  3. 文学的記号を含む → true
 *  4. それ以外 → false
 */
export const INTERESTING_MIN_CHARS = 5;

/** 構造アイテム (scene / codex-entry / snippet) の previewText 閾値。 */
export const STRUCTURE_INTERESTING_MIN_CHARS = 50;

export const LITERARY_MARKERS = ["——", "…", "！", "？", "「", "」", "『", "』"];

export function isInterestingTextFragment(
  text: string,
  spans: TrashSpan[],
): boolean {
  if (spans.some((s) => s.source === "ai")) return true;
  const charCount = [...text].length;
  if (charCount >= INTERESTING_MIN_CHARS) return true;
  if (LITERARY_MARKERS.some((m) => text.includes(m))) return true;
  return false;
}

/**
 * 構造アイテムが「光る」かの判定 (設計書 §3.3)。
 *  - foreshadow は常に true (伏線は本質的に重要)
 *  - map-sticky は本文 5 文字以上 → true
 *  - scene / codex-entry / snippet は previewText が 50 文字以上 → true
 *  - その他 → false
 */
export function isInterestingStructureItem(
  subKind: TrashSubKind,
  previewText: string,
): boolean {
  const charCount = [...previewText].length;
  switch (subKind) {
    case "foreshadow":
      return true;
    case "map-sticky":
      return charCount >= INTERESTING_MIN_CHARS;
    case "scene":
    case "codex-entry":
    case "snippet":
      return charCount >= STRUCTURE_INTERESTING_MIN_CHARS;
    default:
      return false;
  }
}
