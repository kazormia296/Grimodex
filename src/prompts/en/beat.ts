import type { BeatPromptInput } from "@/features/editor/beat/beatPromptBuilder";
import type { BeatType } from "@/features/editor/SceneBeatNode";

function beatTypeGuidanceEn(beatType: BeatType): string {
  switch (beatType) {
    case "summary":
      return "Expand the instruction into a concise description, avoiding redundant phrasing.";
    case "guided":
      return "Write strictly following the order and tone of the instruction.";
    case "dialogue":
      return "Center the writing on dialogue and action description, keeping narration to a minimum.";
    case "setting":
      return "Emphasize sensory description and spatial arrangement, keeping dialogue to a minimum.";
    case "micro":
      return "Write concisely, within 100 words.";
    case "free":
    default:
      return "";
  }
}

export function buildBeatSystemPromptEn(input: BeatPromptInput): string {
  const lines: string[] = [
    `You are a novel-writing assistant. You write the body text of the scene "${input.sceneTitle}" in the project "${input.projectTitle}" according to the beat instruction.`,
  ];
  if (input.povName) {
    lines.push(`The point of view (POV) of this beat is "${input.povName}".`);
  }
  const guidance = beatTypeGuidanceEn(input.beatType);
  if (guidance) lines.push(guidance);
  if (input.codexSummaries?.trim()) {
    lines.push(`\n## Related Settings\n${input.codexSummaries.trim()}`);
  }
  // User-defined additional instruction (aiPrompt.custom.beat). Add nothing if empty.
  if (input.customInstruction?.trim()) {
    lines.push(
      `\n## Additional Instructions\n${input.customInstruction.trim()}`,
    );
  }
  return lines.join("\n");
}

export function buildBeatUserPromptEn(input: BeatPromptInput): string {
  const sections: string[] = [];
  if (input.sceneTextSoFar.trim().length > 0) {
    sections.push(`## Scene body up to this beat\n${input.sceneTextSoFar}`);
  }
  if (
    input.pendingBeatsSection &&
    input.pendingBeatsSection.trim().length > 0
  ) {
    sections.push(input.pendingBeatsSection.trim());
  }
  sections.push(`## Beat Instruction\n${input.instructions}`);
  sections.push(
    "Following the instruction above, write the continuation as natural prose (roughly 500 words) in English. Output only the body text; do not output any meta-comments or headings.",
  );
  return sections.join("\n\n");
}
