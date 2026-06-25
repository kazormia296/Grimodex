import { JSON_ONLY } from "../shared/jsonContract";

function customInstructionLines(customInstruction?: string): string[] {
  const custom = customInstruction?.trim();
  if (!custom) return [];
  return ["", "【追加指示】", custom];
}

/**
 * Phase 4a: 既存本文からサブプロット（プロットスレッド＝縦糸）＋起承転結マーカーを
 * 抽出するプロンプト。foreshadow.buildAuditChapterPrompt と同型（証拠主義・JSON_ONLY）。
 */
export function buildProposePlotThreadsPromptJa(params: {
  existingList: string;
  sceneTexts: string;
  customInstruction?: string;
}): string {
  return [
    "あなたは小説の構成編集アシスタントです。",
    "以下のシーン本文を読み、作中を貫く「サブプロット（プロットスレッド＝縦糸）」を抽出してください。",
    "サブプロットとは複数シーンにまたがって展開する1つの筋です（例: ある人物の復讐、ある謎の解明、ある関係の変化）。",
    "",
    "【ルール】",
    "- 本文に実際に書かれている描写・展開のみを根拠とする（推測・捏造禁止）",
    "- 各スレッドに短く具体的な name（10〜20字程度）と、その筋を1文で表す description を付ける",
    "- 各スレッドに、関与するシーンを markers として列挙する。各 marker は evidenceSceneId（必ず下記シーン一覧の id）と phaseType を持つ",
    "- phaseType は起承転結の段階: introduce(導入) / develop(展開) / turn(転換) / climax(山場) / resolve(決着) のいずれか",
    "- 1つのスレッドは少なくとも2シーンにまたがること（単発の出来事はスレッドにしない）",
    "- 確信できないサブプロットは出さない（偽陽性を避ける）。3〜6本程度に絞る",
    "- 既存スレッド一覧と意味が重複するものは出さない",
    ...customInstructionLines(params.customInstruction),
    "",
    'JSON形式: {"threads":[{"name":"...","description":"...","markers":[{"evidenceSceneId":"...","phaseType":"introduce|develop|turn|climax|resolve","note":"(省略可)"}]}]}',
    JSON_ONLY,
    "",
    "[既存スレッド（重複除外リスト）]",
    params.existingList,
    "",
    "[シーン本文]",
    params.sceneTexts,
  ].join("\n");
}
