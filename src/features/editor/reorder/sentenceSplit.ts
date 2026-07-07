import type { ReorderUnit } from "./types";

/** UTF-16 code unit 半開区間。 */
export interface Utf16Range {
  from: number;
  to: number;
}

/** 文字列を code point 単位で走査し、各文字の UTF-16 開始位置を返す。 */
function* iterateChars(
  text: string,
): Generator<{ utf16Start: number; char: string }> {
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i)!;
    const char = String.fromCodePoint(codePoint);
    yield { utf16Start: i, char };
    i += char.length;
  }
}

function charUtf16End(utf16Start: number, char: string): number {
  return utf16Start + char.length;
}

/**
 * 括弧深度を考慮した日本語文分割（Rust `split_sentences_ja` と parity）。
 * 終端は `。！？!?` に加え読点 `、` も区切りとする。
 * 返却 range は UTF-16 code unit 基準。
 */
export function sentenceRangesJa(text: string): Utf16Range[] {
  const out: Utf16Range[] = [];
  if (text.length === 0) return out;

  let depth = 0;
  let start = 0;
  const chars = [...iterateChars(text)];

  for (let idx = 0; idx < chars.length; idx++) {
    const { utf16Start, char } = chars[idx]!;
    switch (char) {
      case "「":
      case "『":
      case "（":
      case "(":
        depth += 1;
        break;
      case "」":
      case "』":
      case "）":
      case ")":
        depth = Math.max(0, depth - 1);
        break;
      case "。":
      case "！":
      case "？":
      case "!":
      case "?":
        if (depth === 0) {
          let end = charUtf16End(utf16Start, char);
          let j = idx + 1;
          while (j < chars.length) {
            const next = chars[j]!;
            if (
              matchesAny(next.char, "」", "』", "）", ")", "！", "？", "!", "?")
            ) {
              end = charUtf16End(next.utf16Start, next.char);
              j += 1;
            } else {
              break;
            }
          }
          out.push({ from: start, to: end });
          start = end;
          idx = j - 1;
        }
        break;
      case "、":
        if (depth === 0) {
          const end = charUtf16End(utf16Start, char);
          out.push({ from: start, to: end });
          start = end;
        }
        break;
      default:
        break;
    }
  }

  if (start < text.length) {
    out.push({ from: start, to: text.length });
  }
  return out;
}

function matchesAny(char: string, ...candidates: string[]): boolean {
  return candidates.includes(char);
}

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "st",
  "jr",
  "sr",
  "vs",
  "etc",
  "inc",
  "ltd",
  "co",
  "capt",
  "lt",
  "sgt",
  "col",
  "gen",
  "rev",
  "hon",
  "gov",
  "sen",
  "rep",
  "messrs",
  "mt",
  "ave",
  "blvd",
  "no",
  "dept",
  "fig",
  "vol",
  "pp",
]);

function isSentenceBoundaryEn(
  chars: Array<{ utf16Start: number; char: string }>,
  i: number,
  c: string,
  word: string,
  wordAllUpper: boolean,
  wordLen: number,
): boolean {
  if (c === ".") {
    const prevDigit =
      i > 0 && chars[i - 1]!.char >= "0" && chars[i - 1]!.char <= "9";
    const nextDigit =
      i + 1 < chars.length &&
      chars[i + 1]!.char >= "0" &&
      chars[i + 1]!.char <= "9";
    if (prevDigit && nextDigit) return false;
    if (i + 1 < chars.length && chars[i + 1]!.char === ".") return false;
    if (word.length > 0) {
      if (ABBREVIATIONS.has(word)) return false;
      if (wordLen === 1 && wordAllUpper) return false;
    }
  }

  let j = i + 1;
  while (j < chars.length) {
    const nc = chars[j]!.char;
    if (
      nc === '"' ||
      nc === "'" ||
      nc === "\u201D" ||
      nc === "\u2019" ||
      nc === ")" ||
      nc === "]" ||
      nc === "!" ||
      nc === "?" ||
      nc === "."
    ) {
      j += 1;
    } else {
      break;
    }
  }
  while (j < chars.length && /\s/.test(chars[j]!.char)) j += 1;

  if (j >= chars.length) return true;
  const nc = chars[j]!.char;
  return (
    (nc >= "A" && nc <= "Z") ||
    (nc >= "0" && nc <= "9") ||
    nc === '"' ||
    nc === "'" ||
    nc === "\u201C" ||
    nc === "\u2018" ||
    nc.charCodeAt(0) > 127
  );
}

/**
 * 英語文分割（Rust `sentence_ranges_en` と parity、UTF-16 range）。
 */
export function sentenceRangesEn(text: string): Utf16Range[] {
  const out: Utf16Range[] = [];
  if (text.length === 0) return out;

  const chars = [...iterateChars(text)];
  let depth = 0;
  let start = 0;
  let word = "";
  let wordAllUpper = true;
  let wordLen = 0;

  for (let i = 0; i < chars.length; i++) {
    const { utf16Start, char: c } = chars[i]!;
    if (c === "(" || c === "[" || c === "\uFF08") depth += 1;
    else if (c === ")" || c === "]" || c === "\uFF09")
      depth = Math.max(0, depth - 1);

    const isTerminal = c === "." || c === "!" || c === "?";
    if (isTerminal && depth === 0) {
      if (isSentenceBoundaryEn(chars, i, c, word, wordAllUpper, wordLen)) {
        let end = charUtf16End(utf16Start, c);
        let j = i + 1;
        while (j < chars.length) {
          const nc = chars[j]!.char;
          if (
            nc === '"' ||
            nc === "'" ||
            nc === "\u201D" ||
            nc === "\u2019" ||
            nc === ")" ||
            nc === "]" ||
            nc === "!" ||
            nc === "?" ||
            nc === "."
          ) {
            end = charUtf16End(chars[j]!.utf16Start, nc);
            j += 1;
          } else {
            break;
          }
        }
        out.push({ from: start, to: end });
        start = end;
        i = j - 1;
        word = "";
        wordAllUpper = true;
        wordLen = 0;
        continue;
      }
    }

    if (/[A-Za-z0-9]/.test(c)) {
      word += c.toLowerCase();
      if (c < "A" || c > "Z") wordAllUpper = false;
      wordLen += 1;
    } else {
      word = "";
      wordAllUpper = true;
      wordLen = 0;
    }
  }

  if (start < text.length) {
    out.push({ from: start, to: text.length });
  }
  return out;
}

export function splitSentencesJa(text: string): ReorderUnit[] {
  return sentenceRangesJa(text).map(({ from, to }) => ({
    from,
    to,
    surface: text.slice(from, to),
  }));
}

export function splitSentencesEn(text: string): ReorderUnit[] {
  return sentenceRangesEn(text).map(({ from, to }) => ({
    from,
    to,
    surface: text.slice(from, to),
  }));
}

/** プロジェクト言語に応じた文分割。 */
export function splitSentences(
  text: string,
  language: string | undefined,
): ReorderUnit[] {
  const lang = (language ?? "ja").toLowerCase();
  if (lang.startsWith("en")) return splitSentencesEn(text);
  return splitSentencesJa(text);
}
