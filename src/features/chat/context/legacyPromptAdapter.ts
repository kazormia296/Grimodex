import {
  buildSystemPrompt,
  type BuildSystemPromptInput,
  type SystemPromptResult,
} from "../contextBuilder";

export type LegacyPromptResult = Omit<SystemPromptResult, "contextPlan"> & {
  /** Added by the typed context pipeline; absent during the legacy bridge. */
  contextPlan?: SystemPromptResult["contextPlan"];
};

/**
 * Compatibility boundary for the existing renderer. Collection and policy can
 * move out of Zustand without changing a single rendered byte.
 */
export function renderLegacyPrompt(
  input: BuildSystemPromptInput,
): LegacyPromptResult {
  const result = buildSystemPrompt(input) as LegacyPromptResult;
  return result;
}
