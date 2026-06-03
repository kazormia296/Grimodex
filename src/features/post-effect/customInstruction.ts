/**
 * customInstruction.ts — 校閲 (post-effect) の system prompt に、ユーザー定義の
 * 追記カスタム指示 (project_settings: aiPrompt.custom.kouetsu) を安全に挿入する。
 *
 * 設計原則:
 * - 追記式のみ。組み込みプロンプトの JSON 出力スキーマ指示は不変。
 * - postEffect.ts の6プロンプトすべてが、出力スキーマ直前に一字一句同じ
 *   「区切り行」を持つ。custom はこの行の *前* に挟むことで、JSON 形式指示が
 *   常に末尾に残り、出力契約を侵食しない。
 * - custom が空なら byte-identical (組み込みプロンプト・input_hash とも不変)。
 * - input_hash は scope 文字列に custom を畳み込む (pseudo_comment の brief と同型)。
 *   非空のときだけ連結することで、既存プロジェクトの完了済みキャッシュを壊さない。
 */

import { normalizeText } from "./canonicalize";

/**
 * postEffect.ts の6プロンプト (consistency/typo/intra/review/pseudoComment/metaStructure)
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
