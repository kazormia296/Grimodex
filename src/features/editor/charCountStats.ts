/**
 * Stats helpers for the char-count popover in the status bar.
 * Pure functions; no React or DOM access.
 */

/** Manuscript-page equivalent (400-char Japanese genkō yōshi convention). */
export function manuscriptPages(charCount: number): number {
  return charCount / 400;
}

/**
 * Estimated reading time in minutes.
 * Uses 500 chars/min — a midpoint of typical Japanese silent-reading pace
 * (400–600 cpm). The result is rounded up to the next minute for short texts
 * so the bar never reads "0 min" when there is content.
 */
export function readingMinutes(charCount: number): number {
  if (charCount <= 0) return 0;
  return Math.max(1, Math.ceil(charCount / 500));
}

/**
 * Word count tolerant of mixed Japanese/Latin text. Splits on whitespace
 * and CJK punctuation and counts non-empty runs. For pure Japanese text
 * without spaces this yields a sentence-clause-like figure rather than a
 * true word count, but no language-aware tokenizer is available client-side.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Split on Latin whitespace + CJK sentence punctuation.
  return trimmed
    .split(/[\s、。！？!?,.；;:：]+/u)
    .filter((chunk) => chunk.length > 0).length;
}
