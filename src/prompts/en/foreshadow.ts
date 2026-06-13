import { JSON_ONLY } from "../shared/jsonContract";

function customInstructionLines(customInstruction?: string): string[] {
  const custom = customInstruction?.trim();
  if (!custom) return [];
  return ["", "[Additional instructions]", custom];
}

export function buildProposePastSetupsPromptEn(params: {
  intent: string;
  payoffSceneId: string;
  payoffExcerpt: string;
  sceneSummary: string;
  codexSummary: string;
  customInstruction?: string;
}): string {
  return [
    "You are a fiction editing assistant.",
    "Propose candidate setups to place in past scenes so that the payoff scene works.",
    "",
    "[Rules]",
    '- If a suitable spot already exists in the text, use kind="designated_existing" and include existingExcerpt (the relevant text excerpt) along with fromPosHint/toPosHint (approximate positions).',
    '- If no suitable spot exists in the text, use kind="inserted_new" and always include suggestedInsertionPoint (e.g. "after the paragraph about X") and suggestedText (the recommended text to insert).',
    "- You may mix both kinds in your proposals.",
    ...customInstructionLines(params.customInstruction),
    "",
    "JSON format:",
    '{"candidates":[{"sceneId":"...","kind":"designated_existing|inserted_new","existingExcerpt":"...","fromPosHint":1,"toPosHint":2,"suggestedInsertionPoint":"...","suggestedText":"...","rationale":"...","predictedStrength":"subtle|moderate|overt"}]}',
    JSON_ONLY,
    "",
    `intent: ${params.intent}`,
    `payoffSceneId: ${params.payoffSceneId}`,
    `payoffExcerpt: ${params.payoffExcerpt}`,
    "",
    "[pastScenes]",
    params.sceneSummary || "(none)",
    "",
    "[relatedCodex]",
    params.codexSummary || "(none)",
  ].join("\n");
}

export function buildEvaluateSetupStrengthPromptEn(params: {
  foreshadowIntent: string;
  setupExcerpt: string;
  customInstruction?: string;
}): string {
  return [
    "You are a fiction editing assistant.",
    'Evaluate how likely the following "foreshadowing text" is to be noticed as foreshadowing by different reader personas.',
    "You are not given the contents of the payoff scene. Evaluate from a reader's first-read perspective.",
    "",
    "[Persona definitions]",
    "- careful (close reader): reads the text carefully and does not miss fine details",
    "- casual (average reader): reads at a standard pace and remembers memorable descriptions",
    "- skim (skim reader): only follows the main thread of the story and skips over details",
    "",
    "[Strength definitions]",
    "- subtle: hard for this persona to notice as foreshadowing (blends in naturally)",
    "- moderate: medium strength, where some readers notice and others do not",
    "- overt: clearly recognizable as foreshadowing to this persona (the reader becomes conscious of it)",
    ...customInstructionLines(params.customInstruction),
    "",
    'JSON format: {"careful":{"strength":"subtle|moderate|overt","reasoning":"..."},"casual":{"strength":"...","reasoning":"..."},"skim":{"strength":"...","reasoning":"..."}}',
    JSON_ONLY,
    "",
    `[Foreshadowing intent] ${params.foreshadowIntent}`,
    "",
    `[Foreshadowing text]\n${params.setupExcerpt}`,
  ].join("\n");
}

export function buildAuditChapterPromptEn(params: {
  existingList: string;
  codexList: string;
  sceneTexts: string;
  customInstruction?: string;
}): string {
  return [
    "You are a fiction editing assistant.",
    "Read the scene text of the following chapter and extract candidate foreshadowing that has not yet been registered.",
    "",
    "[Rules]",
    "- Base candidates only on descriptions or mentions that are actually written in the text (no guessing or fabrication).",
    '- Prioritize "understated descriptions", "concrete details", "repeated mentions", and "unnatural emphasis".',
    "- If a candidate is close in meaning to an existing foreshadowing entry, put that ID in similarToExistingForeshadowId.",
    "- confidence: use low when you cannot be confident, medium when moderately confident, and high only when it is obvious.",
    "- Do not propose candidates you are not confident about (avoid false positives).",
    "- Each candidate must include evidenceSceneId and evidenceExcerpt (a direct quote from the text, ~10-40 words).",
    ...customInstructionLines(params.customInstruction),
    "",
    'JSON format: {"candidates":[{"suggestedTitle":"...","suggestedIntent":"...","evidenceSceneId":"...","evidenceExcerpt":"...","rationale":"...","confidence":"low|medium|high","similarToExistingForeshadowId":"(optional)"}]}',
    JSON_ONLY,
    "",
    "[Existing registered foreshadowing (exclusion list)]",
    params.existingList,
    "",
    "[Related Codex]",
    params.codexList,
    "",
    "[Scene text]",
    params.sceneTexts,
  ].join("\n");
}
