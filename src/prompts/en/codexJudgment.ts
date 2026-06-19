import { JSON_ONLY } from "../shared/jsonContract";
import {
  sanitizeCandidateField,
  type CandidateJudgmentInput,
} from "../ja/codexJudgment";

export type { CandidateJudgmentInput };

/**
 * Single-shot prompt to classify unconfirmed proper-noun candidates (English).
 * Output is JSON only: {judgments:[{surface, suggestedType, summary, aliasOfId}]}.
 */
export function buildCandidateJudgmentPromptEn(
  input: CandidateJudgmentInput,
): string {
  const candidateLines =
    input.candidates
      .map((c) => {
        const ctx = c.context
          ? `\n  context: ${sanitizeCandidateField(c.context)}`
          : "";
        return `- surface=${sanitizeCandidateField(c.surface)} (count ${c.count})${ctx}`;
      })
      .join("\n") || "(none)";

  const entryLines = input.existingEntries.length
    ? input.existingEntries
        .map((e) => {
          const aka = e.aliases.length
            ? ` aka=[${e.aliases.map(sanitizeCandidateField).join(", ")}]`
            : "";
          return `- id=${e.id} name=${sanitizeCandidateField(e.name)}${aka}`;
        })
        .join("\n")
    : "(none)";

  return [
    "You are a worldbuilding (Codex) editing assistant for a novel.",
    "Classify these proper-noun candidates extracted from the prose that are NOT yet registered in the Codex.",
    "",
    "For each candidate decide:",
    "- suggestedType: one of character / location / item / lore (most fitting).",
    "- summary: a concise description of what this entity is (subject = the entity, ~10 words, noun phrase). Summarize — do NOT copy the context sentence verbatim. Empty string if unknown.",
    "- aliasOfId: if it is clearly an alternate spelling/variant of an existing entry, that entry's id; otherwise null.",
    "",
    "Rules:",
    "- Judge from each candidate's context line. Do not invent facts not in the context.",
    "- If an existing entry is clearly the same entity, put its id in aliasOfId (a hint to merge as an alias rather than create new).",
    "- Always pick exactly one suggestedType from the four, even when unsure.",
    "- Do not output a surface that is not in the input.",
    "",
    "JSON format:",
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
