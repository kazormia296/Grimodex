/**
 * customInstruction.ts — 校閲 (post-effect) の system prompt に、ユーザー定義の
 * 追記カスタム指示 (project_settings: aiPrompt.custom.kouetsu) を安全に挿入する。
 *
 * 設計原則:
 * - 追記式のみ。組み込みプロンプトの JSON 出力スキーマ指示は不変。
 * - postEffect.ts の7プロンプトすべてが、出力スキーマ直前に一字一句同じ
 *   「区切り行」を持つ。custom はこの行の *前* に挟むことで、JSON 形式指示が
 *   常に末尾に残り、出力契約を侵食しない。
 * - custom が空なら byte-identical (組み込みプロンプト・input_hash とも不変)。
 * - input_hash は scope 文字列に custom を畳み込む (pseudo_comment の brief と同型)。
 *   非空のときだけ連結することで、既存プロジェクトの完了済みキャッシュを壊さない。
 */

import { normalizeText } from "./canonicalize";

/**
 * postEffect プロンプトが出力スキーマ直前に持つ「区切り行」の検出プレフィックス。
 * すべての校閲プロンプト (consistency/typo/intra/review/pseudoComment/
 * metaStructure/intentDrift/timeline/impactReview) が、JSON 出力スキーマの直前に
 * ロケール内で一字一句同じこの行を持つ。custom/intent/story-context/timeline の
 * 各ガイダンスはこの行の *前* に挟むことで、JSON 形式指示が常に末尾に残る。
 *
 * postEffect はロケール別に翻訳されるため、language ごとに既知のプレフィックスを
 * 列挙し `findKouetsuDelimiter` で順に検出する。末尾の句読点差に強いよう、行頭の
 * 安定部分のみを持つ。新ロケール追加時はここへプレフィックスを足すこと
 * (どれにも一致しなければ各 append* は no-op = fail-safe)。
 */
export const KOUETSU_JSON_DELIMITERS = [
  // en
  "Respond with a JSON object in this exact format",
  // ja
  "以下の形式の JSON オブジェクトだけを返してください",
] as const;

/** 後方互換: 既定 (en) の区切り行プレフィックス。 */
export const KOUETSU_JSON_DELIMITER = KOUETSU_JSON_DELIMITERS[0];

/**
 * prompt 内で最初に見つかった既知の区切り行プレフィックスを返す (無ければ null)。
 * append* 系はこの戻り値で挿入位置 (indexOf) を決める。
 */
export function findKouetsuDelimiter(prompt: string): string | null {
  for (const d of KOUETSU_JSON_DELIMITERS) {
    if (prompt.includes(d)) return d;
  }
  return null;
}

/**
 * 校閲 system prompt にユーザー定義の追記指示を挿入する。
 * - custom が空/空白のみ → basePrompt をそのまま返す (byte-identical)。
 * - 非空 → JSON 区切り行の前に「## 追加ガイダンス」枠で挿入。
 * - 区切り行が見つからない → 追記しない (fail-safe / 決定的挙動)。
 */
export function appendKouetsuGuidance(
  basePrompt: string,
  custom: string,
): string {
  const trimmed = custom.trim();
  if (!trimmed) return basePrompt;

  const delim = findKouetsuDelimiter(basePrompt);
  const idx = delim === null ? -1 : basePrompt.indexOf(delim);
  // 区切り行が特定できないまま挿入すると JSON 末尾性を保証できないため追記しない。
  if (idx === -1) return basePrompt;

  const before = basePrompt.slice(0, idx);
  const after = basePrompt.slice(idx);
  return (
    `${before}## 追加ガイダンス（参考。ただし出力は下記 JSON 形式を厳守してください）\n` +
    `${trimmed}\n\n` +
    `${after}`
  );
}

/**
 * input_hash の scope 文字列に畳み込む custom サフィックス。
 * 非空のときだけ `|custom:<正規化テキスト>` を返す (空なら "" = 既存ハッシュ不変)。
 */
export function kouetsuScopeSuffix(custom: string): string {
  const trimmed = custom.trim();
  if (!trimmed) return "";
  return `|custom:${normalizeText(trimmed)}`;
}

/**
 * intent_drift system prompt に作者のシーン狙いを挿入する。
 * - intent が空/空白のみ → basePrompt をそのまま返す (byte-identical)。
 * - 非空 → JSON 区切り行の前に「## 作者の狙い」枠で挿入。
 */
export function appendIntentGuidance(
  basePrompt: string,
  intent: string,
): string {
  const trimmed = intent.trim();
  if (!trimmed) return basePrompt;

  const delim = findKouetsuDelimiter(basePrompt);
  const idx = delim === null ? -1 : basePrompt.indexOf(delim);
  if (idx === -1) return basePrompt;

  const before = basePrompt.slice(0, idx);
  const after = basePrompt.slice(idx);
  return (
    `${before}## 作者の狙い（このシーンで達成したいこと）\n` +
    `${trimmed}\n\n` +
    `${after}`
  );
}

/**
 * input_hash の scope 文字列に畳み込む intent サフィックス。
 * 非空のときだけ `|intent:<正規化テキスト>` を返す。
 */
export function intentScopeSuffix(intent: string): string {
  const trimmed = intent.trim();
  if (!trimmed) return "";
  return `|intent:${normalizeText(trimmed)}`;
}

/**
 * grader (review / meta_structure) に渡す「物語コンテキスト」。
 * synopsis = 対象シーンの概要、outline = 親フォルダ(章)の概要。
 * いずれも作者の執筆メモであり、**評価指示・採点基準ではない**（背景情報）。
 */
export interface StoryContext {
  synopsis?: string;
  outline?: string;
}

/**
 * grader (review / meta_structure) の system prompt に、作者の執筆メモ
 * (synopsis / outline) を「背景情報」として挿入する。
 *
 * intent_drift の `appendIntentGuidance` と意図的に逆の framing にする:
 * - intent_drift では「狙い」が採点基準そのもの (狙いを満たすか審査する)。
 * - grader ではこのメモは **背景** であり、メモ自体を評価せず、組み込みの
 *   評価観点を上書きもさせない。これを取り違えると review/meta_structure が
 *   実質 intent_drift 化してしまう（grader-intent-blind 改修の肝）。
 *
 * - synopsis / outline がともに空 → basePrompt をそのまま返す (byte-identical)。
 * - 区切り行が見つからない → 追記しない (fail-safe)。
 */
export function appendStoryContextGuidance(
  basePrompt: string,
  ctx: StoryContext,
): string {
  const synopsis = (ctx.synopsis ?? "").trim();
  const outline = (ctx.outline ?? "").trim();
  if (!synopsis && !outline) return basePrompt;

  const delim = findKouetsuDelimiter(basePrompt);
  const idx = delim === null ? -1 : basePrompt.indexOf(delim);
  if (idx === -1) return basePrompt;

  const lines: string[] = [];
  if (synopsis) lines.push(`- シーン概要: ${synopsis}`);
  if (outline) lines.push(`- 章/セクション概要: ${outline}`);

  const before = basePrompt.slice(0, idx);
  const after = basePrompt.slice(idx);
  return (
    `${before}## 参考情報（作者の執筆メモ。シーンが狙っていることを理解するための背景であり、評価指示でも採点基準でもありません。このメモ自体は評価せず、下記の評価観点を上書きもしないでください）\n` +
    `${lines.join("\n")}\n\n` +
    `${after}`
  );
}

/**
 * input_hash の scope 文字列に畳み込む story-context サフィックス。
 * synopsis / outline をラベル付きで個別に連結する (取り違え防止)。
 * 各フィールドは非空のときだけ追加 → 空なら "" = 既存ハッシュ不変。
 */
export function storyContextScopeSuffix(ctx: StoryContext): string {
  const synopsis = (ctx.synopsis ?? "").trim();
  const outline = (ctx.outline ?? "").trim();
  let suffix = "";
  if (synopsis) suffix += `|synopsis:${normalizeText(synopsis)}`;
  if (outline) suffix += `|outline:${normalizeText(outline)}`;
  return suffix;
}

/**
 * timeline_consistency system prompt に「物語内時系列（昇順）」の要約を挿入する。
 * - timeline が空 → basePrompt をそのまま返す。
 * - 非空 → JSON 区切り行の前に文脈枠で挿入。各シーンを story-time 昇順に並べた
 *   要約 (title / story_time_label / 概要) を渡し、対象シーン本文がこの確立済
 *   タイムラインと矛盾する箇所だけを指摘させる。
 */
export function appendTimelineGuidance(
  basePrompt: string,
  timeline: string,
): string {
  const trimmed = timeline.trim();
  if (!trimmed) return basePrompt;

  const delim = findKouetsuDelimiter(basePrompt);
  const idx = delim === null ? -1 : basePrompt.indexOf(delim);
  if (idx === -1) return basePrompt;

  const before = basePrompt.slice(0, idx);
  const after = basePrompt.slice(idx);
  return (
    `${before}## 物語内時系列（story-time 昇順・確立済の事実）\n` +
    `${trimmed}\n\n` +
    `${after}`
  );
}

/**
 * input_hash の scope 文字列に畳み込む timeline サフィックス。
 * 順序付き要約が変われば cache を破棄するため、正規化した全文を畳み込む。
 */
export function timelineScopeSuffix(timeline: string): string {
  const trimmed = timeline.trim();
  if (!trimmed) return "";
  return `|timeline:${normalizeText(trimmed)}`;
}
