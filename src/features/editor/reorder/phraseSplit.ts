import type { ReorderUnit } from "./types";
import { splitWordsEn } from "./wordSplit";
import {
  isNounTag,
  isVerbTag,
  tagEnglishTokens,
  type TaggedToken,
} from "./phrasePosTag";

function mergeSpan(
  text: string,
  tokens: TaggedToken[],
  from: number,
  to: number,
): ReorderUnit {
  const start = tokens[from]!.unit.from;
  const end = tokens[to - 1]!.unit.to;
  return { from: start, to: end, surface: text.slice(start, end) };
}

/** NP: (DT|PRP$)? JJ* (NN|NNS|NNP|NNPS)+ */
function matchNpEnd(tokens: TaggedToken[], start: number): number | null {
  let i = start;
  if (
    i < tokens.length &&
    (tokens[i]!.tag === "DT" || tokens[i]!.tag === "PRP$")
  ) {
    i += 1;
  }
  while (i < tokens.length && tokens[i]!.tag === "JJ") i += 1;
  const nounStart = i;
  while (i < tokens.length && isNounTag(tokens[i]!.tag)) i += 1;
  return i > nounStart ? i : null;
}

/** PP（推敲用）: IN + (NP | JJ/RB/NN 列) */
function matchPpEnd(tokens: TaggedToken[], start: number): number | null {
  if (start >= tokens.length || tokens[start]!.tag !== "IN") return null;
  const npEnd = matchNpEnd(tokens, start + 1);
  if (npEnd !== null) return npEnd;

  let i = start + 1;
  while (
    i < tokens.length &&
    (tokens[i]!.tag === "JJ" ||
      tokens[i]!.tag === "RB" ||
      tokens[i]!.tag === "NN" ||
      tokens[i]!.tag === "NNS" ||
      isNounTag(tokens[i]!.tag))
  ) {
    i += 1;
  }
  return i > start + 1 ? i : null;
}

/** VP: MD? (VB|VBD|VBG|VBN|VBP|VBZ)+ */
function matchVpEnd(tokens: TaggedToken[], start: number): number | null {
  let i = start;
  if (i < tokens.length && tokens[i]!.tag === "MD") i += 1;
  const verbStart = i;
  while (i < tokens.length && isVerbTag(tokens[i]!.tag)) i += 1;
  return i > verbStart ? i : null;
}

function chunkTokens(text: string, tokens: TaggedToken[]): ReorderUnit[] {
  const units: ReorderUnit[] = [];
  let i = 0;
  while (i < tokens.length) {
    const ppEnd = matchPpEnd(tokens, i);
    if (ppEnd !== null) {
      units.push(mergeSpan(text, tokens, i, ppEnd));
      i = ppEnd;
      continue;
    }

    const npEnd = matchNpEnd(tokens, i);
    if (npEnd !== null) {
      units.push(mergeSpan(text, tokens, i, npEnd));
      i = npEnd;
      continue;
    }

    const vpEnd = matchVpEnd(tokens, i);
    if (vpEnd !== null) {
      units.push(mergeSpan(text, tokens, i, vpEnd));
      i = vpEnd;
      continue;
    }

    units.push(tokens[i]!.unit);
    i += 1;
  }
  return units;
}

/** 文末候補（. ! ? に閉じ括弧・引用符が続く形）。 */
function isSentenceFinal(surface: string): boolean {
  return /[.!?]["')\]\u201d\u2019\u300d\u300f]*$/.test(surface);
}

/**
 * UTF-16 半開区間で POS ルールベース shallow phrase chunk 化（英語のみ）。
 * chunk は文境界を跨がない（NLP chunking の "1 文ずつ処理" 慣行に従う）。
 * 文末句読点は語トークンに含まれるため、文末語で区切って各文を独立に chunk 化する。
 * これにより文をまたいだ動詞連結・名詞連結の誤結合を防ぐ。
 * トークンをパーティションするだけなので、全語が必ず 1 chunk に属し被覆に穴は開かない。
 */
export function splitPhrasesEn(text: string): ReorderUnit[] {
  const words = splitWordsEn(text);
  if (words.length === 0) return [];

  const out: ReorderUnit[] = [];
  let sentence: ReorderUnit[] = [];
  const flush = () => {
    if (sentence.length === 0) return;
    out.push(...chunkTokens(text, tagEnglishTokens(sentence)));
    sentence = [];
  };
  for (const word of words) {
    sentence.push(word);
    if (isSentenceFinal(word.surface)) flush();
  }
  flush();
  return out;
}

/**
 * 英語 phrase unit 連結時に区切り空白が必要か。
 * phrase は語間空白を含む surface を持つが、swap 後の補完契約は word と同型。
 */
export function needsEnglishPhraseGap(
  prev: ReorderUnit,
  next: ReorderUnit,
): boolean {
  const a = prev.surface;
  const b = next.surface;
  if (!a || !b) return false;
  if (/\s$/.test(a) || /^\s/.test(b)) return false;
  return true;
}
