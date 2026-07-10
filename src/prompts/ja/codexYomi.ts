import { JSON_ONLY } from "../shared/jsonContract";

// プロンプト・インジェクション対策: 表記 (name/alias) はユーザー本文由来の自由文。
// `[entries]` のようなセクション境界トークンをそのまま含むと構造を偽装できるため、
// codexJudgment.sanitizeCandidateField と同じ発想で角括弧の直後に `\` を挿入する。
const RESERVED_SECTION_TOKEN_RE = /\[(?=\s*entries\b)/gi;

/** 自由文中のセクション境界トークン偽装を無害化する。 */
export function sanitizeYomiField(text: string): string {
  return text.replace(RESERVED_SECTION_TOKEN_RE, "[\\");
}

/** 読み推定の入力。エントリごとに、読みを求める表記(漢字を含むもの)とカテゴリ。 */
export interface YomiEstimationInput {
  entries: {
    id: string;
    /** 表示用カテゴリラベル (例「人物」「場所」)。読みの曖昧性解消のヒント。 */
    category: string;
    /** 読みを推定してほしい表記 (name / alias のうち漢字を含むもの)。 */
    surfaces: string[];
  }[];
}

/**
 * 漢字を含む固有名詞表記の読みをひらがなで推定させる single-shot プロンプト (日本語)。
 * 出力は {readings:[{id, surface, yomi}]} の JSON のみ。yomi はひらがな 1 読み。
 */
export function buildYomiEstimationPromptJa(
  input: YomiEstimationInput,
): string {
  const entryLines =
    input.entries
      .map((e) => {
        const surfaces = e.surfaces
          .map((s) => sanitizeYomiField(s))
          .join(" / ");
        return `- id=${e.id} 種別=${sanitizeYomiField(e.category)} 表記=[${surfaces}]`;
      })
      .join("\n") || "(なし)";

  return [
    "あなたは日本語小説の固有名詞の読み(ふりがな)を判定するアシスタントです。",
    "各エントリの表記について、最も自然な読みを **ひらがな** で1つ推定してください。",
    "",
    "【ルール】",
    "- yomi は必ずひらがな。カタカナ・漢字・ローマ字を混ぜない。",
    "- 創作固有名詞は種別(人物/場所など)を手がかりに、人名・地名として自然な読みを選ぶ。",
    "- 1つの表記につき最も一般的な読みを1つだけ返す(複数読みは不要)。",
    "- 入力(entries)に無い id / 表記を出力しない。読みが全く推測できない表記は省略してよい。",
    "- 長音は「ー」で表す(例: れーざー)。",
    "",
    "JSON 形式:",
    '{"readings":[{"id":"...","surface":"漢字表記そのまま","yomi":"ひらがな"}]}',
    JSON_ONLY,
    "",
    "[entries]",
    entryLines,
  ].join("\n");
}
