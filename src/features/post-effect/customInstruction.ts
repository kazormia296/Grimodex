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
 * postEffect.ts の7プロンプト (consistency/typo/intra/review/pseudoComment/metaStructure/intentDrift)
 * すべてが共有する、出力スキーマ直前の区切り行。これより前に追記する。
 * 将来 postEffect をロケール別にする場合は、この検出も更新すること
 * (一致しなければ appendKouetsuGuidance は no-op になる = fail-safe)。
 */
export const KOUETSU_JSON_DELIMITER =
  "Respond with a JSON object in this exact format (no markdown, no explanation, only the JSON):";

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

  const idx = basePrompt.indexOf(KOUETSU_JSON_DELIMITER);
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

  const idx = basePrompt.indexOf(KOUETSU_JSON_DELIMITER);
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

  const idx = basePrompt.indexOf(KOUETSU_JSON_DELIMITER);
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
