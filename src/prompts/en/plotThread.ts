import { JSON_ONLY } from "../shared/jsonContract";

function customInstructionLines(customInstruction?: string): string[] {
  const custom = customInstruction?.trim();
  if (!custom) return [];
  return ["", "[Additional instructions]", custom];
}

/**
 * Phase 4a: extract sub-plots (plot threads / through-lines) + narrative-phase
 * markers from existing prose. Mirrors foreshadow.buildAuditChapterPrompt
 * (evidence-only, JSON_ONLY).
 */
export function buildProposePlotThreadsPromptEn(params: {
  existingList: string;
  sceneTexts: string;
  customInstruction?: string;
}): string {
  return [
    "You are a structural editor for novels.",
    'Read the scene texts below and extract the "sub-plots" (plot threads / through-lines) that run through the work.',
    "A sub-plot is a single strand that unfolds across multiple scenes (e.g. a character's revenge, the unraveling of a mystery, the change in a relationship).",
    "",
    "[Rules]",
    "- Base everything strictly on what is actually written in the prose (no speculation or fabrication)",
    "- Give each thread a short, concrete name and a one-sentence description of its arc",
    "- For each thread, list the scenes involved as markers. Each marker has an evidenceSceneId (MUST be an id from the scene list below) and a phaseType",
    "- phaseType is the narrative stage: introduce / develop / turn / climax / resolve",
    "- Each thread must span at least two scenes (do not make a thread out of a one-off event)",
    "- Do not output sub-plots you are unsure about (avoid false positives). Keep it to roughly 3-6 threads",
    "- Do not output threads that overlap in meaning with the existing-threads list",
    ...customInstructionLines(params.customInstruction),
    "",
    'JSON shape: {"threads":[{"name":"...","description":"...","markers":[{"evidenceSceneId":"...","phaseType":"introduce|develop|turn|climax|resolve","note":"(optional)"}]}]}',
    JSON_ONLY,
    "",
    "[Existing threads (exclude duplicates)]",
    params.existingList,
    "",
    "[Scene texts]",
    params.sceneTexts,
  ].join("\n");
}
