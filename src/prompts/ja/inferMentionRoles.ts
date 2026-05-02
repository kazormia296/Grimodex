import type { RoleInferenceInput } from "@/features/editor/beat/inferMentionRoles";
import { JSON_ONLY } from "../shared/jsonContract";

export function buildMentionRolesPromptJa(input: RoleInferenceInput): string {
  const mentionLines = input.mentions
    .map((m) => `- ${m.name} (id=${m.codexId}) 現在の役割: ${m.currentRole}`)
    .join("\n");

  return [
    "あなたは小説のシーン解析アシスタントです。",
    "以下の散文中で、各キャラクターが「actor（行動主体）」「target（対象）」「mentioned（言及のみ）」",
    "のいずれかを推定し、JSON のみを返してください。",
    "確信が持てない場合は confidence を低めに設定してください。",
    "",
    "[ビート指示]",
    input.beatInstructions,
    "",
    "[生成された散文]",
    input.generatedProse,
    "",
    "[登場キャラクター]",
    mentionLines,
    "",
    '{"results":[{"codexId":"...","role":"actor|target|mentioned","confidence":0.0-1.0}]}',
    JSON_ONLY,
  ].join("\n");
}
