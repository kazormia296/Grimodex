import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import type { MentionRole } from "@/features/codex/CodexMentionExtension";

export interface RoleInferenceInput {
  beatInstructions: string;
  generatedProse: string;
  mentions: { codexId: string; name: string; currentRole: MentionRole }[];
}

export interface RoleSuggestion {
  codexId: string;
  role: MentionRole;
  confidence: number;
}

interface InferenceResultItem {
  codexId: unknown;
  role: unknown;
  confidence: unknown;
}

interface InferenceResponse {
  results: InferenceResultItem[];
}

function isValidRole(value: unknown): value is MentionRole {
  return value === "actor" || value === "target" || value === "mentioned";
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function buildPrompt(input: RoleInferenceInput): string {
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
    "JSON 形式のみで返答してください（他のテキストは一切含めない）:",
    '{"results":[{"codexId":"...","role":"actor|target|mentioned","confidence":0.0-1.0}]}',
  ].join("\n");
}

/**
 * Given beat instructions, generated prose, and a list of @mentions, ask the
 * AI to infer the role each character played in the prose.
 * Returns an empty array on any error or when mentions is empty.
 */
export async function inferMentionRoles(
  input: RoleInferenceInput,
): Promise<RoleSuggestion[]> {
  if (input.mentions.length === 0) return [];

  const prompt = buildPrompt(input);

  let responseText: string;
  try {
    const result = await sendChatMessageWithThinking([
      { role: "user", content: prompt },
    ]);
    responseText = result.text;
  } catch {
    return [];
  }

  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return [];

  try {
    const parsed = JSON.parse(jsonText) as InferenceResponse;
    if (!Array.isArray(parsed.results)) return [];

    return parsed.results.flatMap((item) => {
      if (typeof item.codexId !== "string") return [];
      if (!isValidRole(item.role)) return [];
      const confidence =
        typeof item.confidence === "number"
          ? Math.min(1, Math.max(0, item.confidence))
          : 0;
      return [{ codexId: item.codexId, role: item.role, confidence }];
    });
  } catch {
    return [];
  }
}
