import { buildSystemPrompt, ensureTokenizer } from "../contextBuilder";
import {
  createContextPlannerDeps,
  type ContextPlannerDeps,
} from "./contextPlannerDeps";

/**
 * Production composition root. Source adapters are supplied explicitly while
 * the stable tokenizer and byte-compatible renderer are wired in one place.
 */
export function createDefaultContextPlannerDeps(
  sources: Pick<ContextPlannerDeps, "collectRequiredSceneContext"> &
    Partial<Pick<ContextPlannerDeps, "collectOptionalSceneContext">>,
): ContextPlannerDeps {
  return createContextPlannerDeps({
    ensureTokenizer,
    renderPrompt: buildSystemPrompt,
    ...sources,
  });
}
