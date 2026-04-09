export type CharClass =
  | "hiragana"
  | "katakana"
  | "kanji"
  | "latin"
  | "digit"
  | "other";

export function getCharClass(ch: string): CharClass {
  const code = ch.codePointAt(0)!;
  if (code >= 0x3040 && code <= 0x309f) return "hiragana";
  if (code >= 0x30a0 && code <= 0x30ff) return "katakana";
  if (code >= 0x4e00 && code <= 0x9fff) return "kanji";
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
    return "latin";
  if (code >= 0x30 && code <= 0x39) return "digit";
  return "other";
}

/**
 * Returns true if the boundary at [start, end) in text is valid —
 * i.e. the matched substring is not part of a larger same-class token.
 */
export function isValidBoundary(
  text: string,
  start: number,
  end: number,
): boolean {
  const charBefore = start > 0 ? text[start - 1] : "";
  const charAfter = end < text.length ? text[end] : "";

  const firstChar = text[start];
  const lastChar = text[end - 1];

  // Pattern length (in JS chars = UTF-16 code units, BMP only)
  const patternLen = end - start;

  // Check left boundary
  if (charBefore) {
    const classBefore = getCharClass(charBefore);
    const classFirst = getCharClass(firstChar);
    if (classBefore === classFirst && classBefore !== "other") {
      // Kanji 2+ char patterns: allow kanji-kanji left boundary.
      // Kanji compounds are naturally adjacent (e.g. 女|王様, 山田|太郎).
      if (!(classBefore === "kanji" && patternLen >= 2)) return false;
    }
  }

  // Check right boundary — only for katakana, kanji, latin endings.
  // Hiragana-ending patterns (e.g. 見習い, まどか) are commonly followed by
  // hiragana particles (が、は、を…) which is valid — skip the check.
  if (charAfter) {
    const classLast = getCharClass(lastChar);
    if (classLast !== "hiragana" && classLast !== "other") {
      const classAfter = getCharClass(charAfter);
      if (classLast === classAfter) {
        // Kanji 2+ char patterns: allow kanji-kanji right boundary.
        // Reason: kanji are adjacent across word boundaries (佐藤|上等兵, 東京|都).
        if (!(classLast === "kanji" && patternLen >= 2)) return false;
      }
    }
  }

  return true;
}
