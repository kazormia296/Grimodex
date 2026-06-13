import type { RoleInferenceInput } from "@/features/editor/beat/inferMentionRoles";
import { JSON_ONLY } from "../shared/jsonContract";

export function buildMentionRolesPromptEn(input: RoleInferenceInput): string {
  const mentionLines = input.mentions
    .map((m) => `- ${m.name} (id=${m.codexId}) current role: ${m.currentRole}`)
    .join("\n");

  return [
    "You are a novel scene analysis assistant.",
    'In the prose below, infer whether each character is an "actor" (the one performing the action), a "target" (the one acted upon), or "mentioned" (referenced only),',
    "and return JSON only.",
    "If you are not confident, set a lower confidence value.",
    "",
    "[Beat Instructions]",
    input.beatInstructions,
    "",
    "[Generated Prose]",
    input.generatedProse,
    "",
    "[Characters Present]",
    mentionLines,
    "",
    '{"results":[{"codexId":"...","role":"actor|target|mentioned","confidence":0.0-1.0}]}',
    JSON_ONLY,
  ].join("\n");
}
