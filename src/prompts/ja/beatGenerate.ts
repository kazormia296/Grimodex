import { BEAT_TYPES } from "@/features/editor/beat/beatTypes";
import { JSON_ONLY } from "../shared/jsonContract";

export function buildGenerateBeatsMessagesJa(
  projectTitle: string,
  sceneTitle: string,
  synopsis: string,
): { role: string; content: string }[] {
  const beatTypeList = BEAT_TYPES.join(" | ");
  return [
    {
      role: "system",
      content:
        `あなたは小説執筆アシスタントです。プロジェクト「${projectTitle}」のシーン「${sceneTitle}」のシノプシスから、実行可能なビートリストを提案します。\n` +
        `{"beats": [{"beatType": "${beatTypeList}", "instructions": "日本語の指示文"}]}\n` +
        JSON_ONLY,
    },
    {
      role: "user",
      content: `以下のシノプシスから、このシーンのビートを3〜6件提案してください。\n\n## シノプシス\n${synopsis}`,
    },
  ];
}

export function buildGenerateSynopsisMessagesJa(
  projectTitle: string,
  sceneTitle: string,
  beatList: string,
): { role: string; content: string }[] {
  return [
    {
      role: "system",
      content: `あなたは小説執筆アシスタントです。プロジェクト「${projectTitle}」のシーン「${sceneTitle}」のビートリストから、簡潔なシノプシスを1〜3文で生成します。`,
    },
    {
      role: "user",
      content: `以下のビートリストを元に、このシーンのシノプシスを1〜3文で書いてください。本文は書かず、要約のみ出力してください。\n\n## ビートリスト\n${beatList}`,
    },
  ];
}
