import { BEAT_TYPES } from "@/features/editor/SceneBeatNode";
import { JSON_ONLY } from "../shared/jsonContract";

export function buildGenerateBeatsMessagesEn(
  projectTitle: string,
  sceneTitle: string,
  synopsis: string,
): { role: string; content: string }[] {
  const beatTypeList = BEAT_TYPES.join(" | ");
  return [
    {
      role: "system",
      content:
        `You are a novel-writing assistant. From the synopsis of scene "${sceneTitle}" in project "${projectTitle}", you propose an actionable list of beats.\n` +
        `{"beats": [{"beatType": "${beatTypeList}", "instructions": "instruction text in English"}]}\n` +
        JSON_ONLY,
    },
    {
      role: "user",
      content: `From the synopsis below, propose 3 to 6 beats for this scene.\n\n## Synopsis\n${synopsis}`,
    },
  ];
}

export function buildGenerateSynopsisMessagesEn(
  projectTitle: string,
  sceneTitle: string,
  beatList: string,
): { role: string; content: string }[] {
  return [
    {
      role: "system",
      content: `You are a novel-writing assistant. From the beat list of scene "${sceneTitle}" in project "${projectTitle}", you generate a concise synopsis in 1 to 3 sentences.`,
    },
    {
      role: "user",
      content: `Based on the beat list below, write a synopsis for this scene in 1 to 3 sentences. Do not write the prose itself; output only the summary.\n\n## Beat list\n${beatList}`,
    },
  ];
}
