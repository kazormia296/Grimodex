import type { ReorderUnit } from "./types";

/** Penn Treebank 風の粗 POS（ルールベース chunking 用）。 */
export type RoughPosTag =
  | "DT"
  | "PRP"
  | "PRP$"
  | "IN"
  | "JJ"
  | "NN"
  | "NNS"
  | "NNP"
  | "NNPS"
  | "VB"
  | "VBD"
  | "VBG"
  | "VBN"
  | "VBP"
  | "VBZ"
  | "MD"
  | "RB"
  | "CC"
  | "CD"
  | "WP"
  | "OTHER";

export interface TaggedToken {
  unit: ReorderUnit;
  tag: RoughPosTag;
}

const DETERMINERS = new Set(["a", "an", "the"]);

const POSSESSIVES = new Set([
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
]);

const PRONOUNS = new Set([
  "i",
  "me",
  "he",
  "him",
  "she",
  "her",
  "it",
  "we",
  "us",
  "you",
  "they",
  "them",
  "who",
  "whom",
  "whose",
  "what",
  "which",
  "this",
  "that",
  "these",
  "those",
]);

const WH_WORDS = new Set([
  "who",
  "whom",
  "whose",
  "what",
  "which",
  "where",
  "when",
  "why",
  "how",
]);

const PREPOSITIONS = new Set([
  "at",
  "in",
  "on",
  "from",
  "with",
  "to",
  "by",
  "for",
  "of",
  "into",
  "onto",
  "upon",
  "under",
  "over",
  "through",
  "during",
  "before",
  "after",
  "between",
  "among",
  "against",
  "about",
  "around",
  "across",
  "behind",
  "beyond",
  "beside",
  "beneath",
  "within",
  "without",
  "toward",
  "towards",
  "off",
  "out",
  "up",
  "down",
  "via",
  "per",
  "than",
  "like",
  "as",
  "until",
  "since",
  "while",
  "unless",
  "although",
  "though",
  "if",
  "when",
  "where",
]);

const MODALS = new Set([
  "will",
  "would",
  "shall",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
]);

const AUX_BE = new Set([
  "be",
  "am",
  "is",
  "are",
  "was",
  "were",
  "been",
  "being",
]);

const AUX_HAVE = new Set(["have", "has", "had", "having"]);

const AUX_DO = new Set(["do", "does", "did", "doing"]);

const CONJUNCTIONS = new Set(["and", "or", "but", "nor", "so", "yet"]);

const PAST_TENSE_VERBS = new Set([
  "went",
  "came",
  "stood",
  "sat",
  "walked",
  "ran",
  "waited",
  "waved",
  "said",
  "saw",
  "made",
  "took",
  "got",
  "knew",
  "thought",
  "looked",
  "wanted",
  "worked",
  "called",
  "tried",
  "asked",
  "needed",
  "felt",
  "left",
  "kept",
  "helped",
  "showed",
  "heard",
  "played",
  "moved",
  "lived",
  "believed",
  "held",
  "brought",
  "happened",
  "wrote",
  "provided",
  "lost",
  "paid",
  "met",
  "included",
  "continued",
  "learned",
  "learnt",
  "changed",
  "led",
  "understood",
  "watched",
  "followed",
  "stopped",
  "created",
  "spoke",
  "allowed",
  "added",
  "spent",
  "grew",
  "opened",
  "won",
  "offered",
  "remembered",
  "loved",
  "considered",
  "appeared",
  "bought",
  "served",
  "died",
  "sent",
  "expected",
  "built",
  "stayed",
  "fell",
  "reached",
  "killed",
  "remained",
  "suggested",
  "raised",
  "passed",
  "sold",
  "required",
  "reported",
  "decided",
  "pulled",
  "reckoned",
  "narrowed",
]);

const COMMON_VERBS = new Set([
  "go",
  "went",
  "gone",
  "come",
  "came",
  "stand",
  "stood",
  "sit",
  "sat",
  "walk",
  "walked",
  "run",
  "ran",
  "wait",
  "waited",
  "wave",
  "waved",
  "say",
  "said",
  "see",
  "saw",
  "seen",
  "make",
  "made",
  "take",
  "took",
  "taken",
  "get",
  "got",
  "gotten",
  "know",
  "knew",
  "known",
  "think",
  "thought",
  "look",
  "looked",
  "want",
  "wanted",
  "work",
  "worked",
  "call",
  "called",
  "try",
  "tried",
  "ask",
  "asked",
  "need",
  "needed",
  "feel",
  "felt",
  "leave",
  "left",
  "keep",
  "kept",
  "help",
  "helped",
  "show",
  "showed",
  "shown",
  "hear",
  "heard",
  "play",
  "played",
  "move",
  "moved",
  "live",
  "lived",
  "believe",
  "believed",
  "hold",
  "held",
  "bring",
  "brought",
  "happen",
  "happened",
  "write",
  "wrote",
  "written",
  "provide",
  "provided",
  "lose",
  "lost",
  "pay",
  "paid",
  "meet",
  "met",
  "include",
  "included",
  "continue",
  "continued",
  "learn",
  "learned",
  "learnt",
  "change",
  "changed",
  "lead",
  "led",
  "understand",
  "understood",
  "watch",
  "watched",
  "follow",
  "followed",
  "stop",
  "stopped",
  "create",
  "created",
  "speak",
  "spoke",
  "spoken",
  "read",
  "allow",
  "allowed",
  "add",
  "added",
  "spend",
  "spent",
  "grow",
  "grew",
  "grown",
  "open",
  "opened",
  "win",
  "won",
  "offer",
  "offered",
  "remember",
  "remembered",
  "love",
  "loved",
  "consider",
  "considered",
  "appear",
  "appeared",
  "buy",
  "bought",
  "serve",
  "served",
  "die",
  "died",
  "send",
  "sent",
  "expect",
  "expected",
  "build",
  "built",
  "stay",
  "stayed",
  "fall",
  "fell",
  "fallen",
  "cut",
  "reach",
  "reached",
  "kill",
  "killed",
  "remain",
  "remained",
  "suggest",
  "suggested",
  "raise",
  "raised",
  "pass",
  "passed",
  "sell",
  "sold",
  "require",
  "required",
  "report",
  "reported",
  "decide",
  "decided",
  "pull",
  "pulled",
  "reckon",
  "reckons",
  "reckoned",
  "narrow",
  "narrowed",
]);

const COMMON_ADJECTIVES = new Set([
  "old",
  "young",
  "new",
  "good",
  "bad",
  "big",
  "small",
  "long",
  "short",
  "high",
  "low",
  "great",
  "little",
  "other",
  "same",
  "different",
  "first",
  "last",
  "next",
  "early",
  "late",
  "hard",
  "easy",
  "right",
  "wrong",
  "true",
  "false",
  "full",
  "whole",
  "free",
  "sure",
  "clear",
  "strong",
  "weak",
  "poor",
  "rich",
  "happy",
  "sad",
  "tall",
  "wide",
  "deep",
  "dark",
  "bright",
  "quiet",
  "loud",
  "fast",
  "slow",
  "close",
  "open",
  "current",
  "major",
  "only",
  "main",
  "final",
  "general",
  "special",
  "possible",
  "likely",
  "afraid",
  "aware",
  "ready",
  "able",
  "lazy",
  "volatile",
  "excellent",
  "unhappy",
]);

const COMMON_ADVERBS = new Set([
  "not",
  "very",
  "well",
  "also",
  "just",
  "even",
  "still",
  "already",
  "always",
  "never",
  "often",
  "sometimes",
  "here",
  "there",
  "now",
  "then",
  "again",
  "away",
  "back",
  "down",
  "up",
  "out",
  "off",
  "over",
  "afar",
  "only",
  "really",
  "quite",
  "rather",
  "too",
  "so",
  "more",
  "most",
  "less",
  "least",
]);

function lemma(surface: string): string {
  return surface.replace(/[.,!?;:]+$/g, "").toLowerCase();
}

function isCapitalized(surface: string): boolean {
  const core = surface.replace(/[.,!?;:]+$/g, "");
  return /^[A-Z]/.test(core);
}

function isPluralLemma(w: string): boolean {
  return w.endsWith("s") && !w.endsWith("ss") && w.length > 3;
}

function tagLemma(w: string, surface: string, index: number): RoughPosTag {
  if (DETERMINERS.has(w)) return "DT";
  if (POSSESSIVES.has(w)) return "PRP$";
  if (PRONOUNS.has(w)) return "PRP";
  if (WH_WORDS.has(w)) return "WP";
  if (PREPOSITIONS.has(w)) return "IN";
  if (MODALS.has(w)) return "MD";
  if (AUX_BE.has(w)) return w === "been" || w === "being" ? "VBG" : "VBZ";
  if (AUX_HAVE.has(w)) return w === "having" ? "VBG" : "VBZ";
  if (AUX_DO.has(w)) return w === "doing" ? "VBG" : "VBZ";
  if (CONJUNCTIONS.has(w)) return "CC";
  if (/^\d+([.,]\d+)?$/.test(w)) return "CD";

  // 既知の閉クラス・常用語を先に確定させる。大文字は固有名詞の手がかりだが、
  // 文中の常用動詞/形容詞（"Stood" "New" 等）まで NNP にすると chunk 境界が
  // 崩れる（VP のはずが NP に吸着される）ため、辞書判定を優先する。
  if (COMMON_ADVERBS.has(w) || w.endsWith("ly")) return "RB";
  if (COMMON_ADJECTIVES.has(w)) return "JJ";

  if (COMMON_VERBS.has(w) || PAST_TENSE_VERBS.has(w)) {
    if (PAST_TENSE_VERBS.has(w)) return "VBD";
    if (w.endsWith("ing") || w === "being") return "VBG";
    if (w.endsWith("ed") || w.endsWith("en")) return "VBD";
    if (w.endsWith("s") && w !== "is" && w !== "was") return "VBZ";
    return "VB";
  }

  // 辞書外の大文字語は固有名詞とみなす。段落頭(index 0)は文頭の大文字と
  // 区別できず曖昧なので NNP 化せず、下の接尾辞ヒューリスティックへ委ねる。
  if (isCapitalized(surface) && index > 0) {
    return isPluralLemma(w) ? "NNPS" : "NNP";
  }

  if (w.length >= 5 && w.endsWith("ing")) return "VBG";
  if (w.length >= 4 && (w.endsWith("ed") || w.endsWith("en"))) return "VBD";
  if (w.length >= 4 && w.endsWith("s") && !w.endsWith("ss")) return "VBZ";

  if (
    w.endsWith("tion") ||
    w.endsWith("ness") ||
    w.endsWith("ment") ||
    w.endsWith("ity") ||
    w.endsWith("ance") ||
    w.endsWith("ence")
  ) {
    return isPluralLemma(w) ? "NNS" : "NN";
  }

  if (isPluralLemma(w)) return "NNS";
  return "NN";
}

/** 語 unit 列に粗 POS を付与する。 */
export function tagEnglishTokens(units: ReorderUnit[]): TaggedToken[] {
  return units.map((unit, index) => ({
    unit,
    tag: tagLemma(lemma(unit.surface), unit.surface, index),
  }));
}

export function isNounTag(tag: RoughPosTag): boolean {
  return tag === "NN" || tag === "NNS" || tag === "NNP" || tag === "NNPS";
}

export function isVerbTag(tag: RoughPosTag): boolean {
  return (
    tag === "VB" ||
    tag === "VBD" ||
    tag === "VBG" ||
    tag === "VBN" ||
    tag === "VBP" ||
    tag === "VBZ"
  );
}
