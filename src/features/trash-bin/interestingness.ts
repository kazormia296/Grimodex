import type { TrashSpan } from "./types";

/**
 * 文字屑が「光る」(`isInteresting === true`) かを判定する純関数。
 * 設計書 v3 §3.3 の文字屑ルール:
 *  1. spans に `source === "ai"` が 1 つでもあれば true
 *  2. 全体テキストが INTERESTING_MIN_CHARS 文字以上 → true
 *  3. 文学的記号を含む → true
 *  4. それ以外 → false
 *
 * 構造アイテム判定は Phase 4-5 で追加（subKind ごとの分岐）。
 */
export const INTERESTING_MIN_CHARS = 5;

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
