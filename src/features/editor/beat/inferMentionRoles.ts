import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import type { MentionRole } from "@/features/codex/CodexMentionExtension";
import { getPromptCatalog } from "@/prompts/index";
import { extractJsonObject } from "@/prompts/shared/jsonContract";

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

function buildPrompt(input: RoleInferenceInput): string {
  return getPromptCatalog("ja").inferMentionRoles.buildPrompt(input);
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
