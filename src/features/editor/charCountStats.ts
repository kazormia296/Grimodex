/**
 * Stats helpers for the char-count popover in the status bar.
 * Pure functions; no React or DOM access.
 *
 * 単位の方針: 一次メトリクス (常時表示する主役の数値) は PROJECT 言語で決める。
 * 英語系プロジェクトは語数 (word) を、それ以外 (日本語など) は文字数 (char) を
 * 主役にする。lang 省略時は文字数扱い = 既存の日本語挙動を不変に保つ。
 * 単位の名詞表示 (字 / chars 等) は UI 言語で localize する (i18n キーは
 * countUnitLabelKey が返す)。
 */

export type CountUnit = "char" | "word";

/**
 * project 言語から一次カウント単位を決める。英語系 (en) は語数、それ以外は
 * 文字数。未指定 / legacy プロジェクトは文字数 (既存挙動を保つ)。
 */
export function primaryCountUnit(lang?: string | null): CountUnit {
  return lang?.startsWith("en") ? "word" : "char";
}

/**
 * 単位名詞の i18n キー (common.unitChars / common.unitWords)。
 * どの単位かは PROJECT 言語で決まるが、名詞自体は UI 言語で localize される。
 */
export function countUnitLabelKey(unit: CountUnit): string {
  return unit === "word" ? "common.unitWords" : "common.unitChars";
}

/**
 * Manuscript-page equivalent.
 * - 文字 (日本語など): 400 字詰め原稿用紙。
 * - 語 (英語など): 標準原稿 1 枚 ≈ 250 words (英語出版の慣習値)。
 * primaryCount は単位に合わせて渡すこと (char なら文字数 / word なら語数)。
 * lang 省略時は 400 字詰め (既存挙動)。
 */
export function manuscriptPages(
  primaryCount: number,
  lang?: string | null,
): number {
  return primaryCount / (lang?.startsWith("en") ? 250 : 400);
}

/**
 * Estimated reading time in minutes.
 * - 文字 (日本語など): 500 chars/min — 典型的な日本語黙読速度 (400–600 cpm) の中点。
 * - 語 (英語など): ~225 words/min — 一般的な英語黙読速度 (200–250 wpm) の中点。
 * 短文でも「0 分」と出ないよう次の 1 分へ切り上げる。primaryCount は単位に
 * 合わせて渡すこと。lang 省略時は 500 cpm (既存挙動)。
 */
export function readingMinutes(
  primaryCount: number,
  lang?: string | null,
): number {
  if (primaryCount <= 0) return 0;
  return Math.max(
    1,
    Math.ceil(primaryCount / (lang?.startsWith("en") ? 225 : 500)),
  );
}

/**
 * Word count tolerant of mixed Japanese/Latin text.
 *
 * - 英語など (lang が en): 連続する空白 (\s+) で分割した非空ランを数える。小数や
 *   略語のピリオド/カンマでは切らないため、MS Word 等と同じ「単語」数に近い
 *   ("Mr. Smith"→2, "well-funded"→1, "3.14"→1)。
 * - それ以外 / lang 省略 (日本語など): 空白 + CJK 句読点で分割する従来の概数。
 *   空白の無い日本語では真の単語数ではなく節クローズ的な値になるが、クライアント
 *   側に言語対応トークナイザは無いため popover の補助表示に留める。既存の日本語
 *   挙動を変えないよう lang 省略時はこちらを使う。
 */
export function countWords(text: string, lang?: string | null): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (lang?.startsWith("en")) {
    return trimmed.split(/\s+/u).filter((chunk) => chunk.length > 0).length;
  }
  // Split on Latin whitespace + CJK sentence punctuation (legacy 日本語 heuristic).
  return trimmed
    .split(/[\s、。！？!?,.；;:：]+/u)
    .filter((chunk) => chunk.length > 0).length;
}
