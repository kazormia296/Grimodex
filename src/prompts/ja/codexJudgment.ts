import { JSON_ONLY } from "../shared/jsonContract";

/** B2 LLM 判定の入力。候補と既存 Codex 名(別名統合の照合先)。 */
export interface CandidateJudgmentInput {
  candidates: {
    surface: string;
    lemma: string;
    count: number;
    context: string;
  }[];
  existingEntries: { id: string; name: string; aliases: string[] }[];
}

/**
 * 未確定固有名詞候補を分類させる single-shot プロンプト (日本語)。
 * 出力は {judgments:[{surface, suggestedType, summary, aliasOfId}]} の JSON のみ。
 */
export function buildCandidateJudgmentPromptJa(
  input: CandidateJudgmentInput,
): string {
  const candidateLines =
    input.candidates
      .map((c) => {
        const ctx = c.context ? `\n  文脈: ${c.context}` : "";
        return `- surface=${c.surface} (出現${c.count}回)${ctx}`;
      })
      .join("\n") || "(なし)";

  const entryLines = input.existingEntries.length
    ? input.existingEntries
        .map((e) => {
          const aka = e.aliases.length ? ` aka=[${e.aliases.join(", ")}]` : "";
          return `- id=${e.id} name=${e.name}${aka}`;
        })
        .join("\n")
    : "(なし)";

  return [
    "あなたは小説の設定(Codex)編集アシスタントです。",
    "本文から抽出された「まだ Codex に登録されていない固有名詞候補」を分類してください。",
    "",
    "各候補について判定:",
    "- suggestedType: character(人物) / location(場所) / item(物・道具) / lore(設定・概念) から最も妥当なもの",
    "- summary: 文脈から分かる範囲の一行説明 (不明なら空文字)",
    "- aliasOfId: 既存エントリ(existingEntries)と同一実体の別表記/誤記だと判断できる場合はその id。新規なら null",
    "",
    "【ルール】",
    "- 各候補の「文脈」行を根拠に判定する。文脈に無い設定を捏造しない。",
    "- 既存エントリに明らかに同一実体があれば aliasOfId にその id を入れる(新規作成でなく別名統合のヒント)。",
    "- 確信が持てなくても suggestedType は 4 種から最も近いものを必ず 1 つ選ぶ。",
    "- 入力に無い surface を出力しない。",
    "",
    "JSON 形式:",
    '{"judgments":[{"surface":"...","suggestedType":"character|location|item|lore","summary":"...","aliasOfId":null}]}',
    JSON_ONLY,
    "",
    "[candidates]",
    candidateLines,
    "",
    "[existingEntries]",
    entryLines,
  ].join("\n");
}
