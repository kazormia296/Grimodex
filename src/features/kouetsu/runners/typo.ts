/**
 * runners/typo.ts — typo_detection の起動。
 * scene = 単発 runPostEffect / folder|project = buildMultiPayload + runPostEffectMulti。
 */

import { getPromptCatalog } from "@/prompts/index";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";
import { flushPendingSceneSaves } from "@/features/post-effect/api";
import { buildMultiPayload } from "@/features/post-effect/consistencyPayloadBuilder";
import {
  buildTypoPayload,
  TYPO_PROMPT_VERSION,
} from "@/features/post-effect/typoPayloadBuilder";
import {
  BLOCKED,
  SKIPPED,
  commonParams,
  guardsPass,
  launchMulti,
  launchSingle,
  multiScope,
  scopeHasNoScenes,
  type KouetsuRunOutcome,
  type KouetsuRunScope,
} from "./shared";

export async function runTypoCheck(
  scope: KouetsuRunScope,
): Promise<KouetsuRunOutcome> {
  if (!guardsPass()) return BLOCKED;
  const { projectId, lang, model, customKouetsu } = commonParams();
  const systemPrompt = appendKouetsuGuidance(
    getPromptCatalog(lang).postEffect.typoSystem,
    customKouetsu,
  );

  if (scope.type === "scene") {
    await flushPendingSceneSaves(scope.sceneId);
    const payload = await buildTypoPayload(scope.sceneId, model, customKouetsu);
    return launchSingle({
      project_id: projectId,
      effect_type: "typo_detection",
      scope_type: "scene",
      scope_target_id: scope.sceneId,
      model,
      prompt_version: TYPO_PROMPT_VERSION,
      input_hash: payload.inputHash,
      codex_payload_json: "[]",
      scene_text: payload.sceneText,
      system_prompt: systemPrompt,
    });
  }

  const { scopeType, scopeTargetId } = multiScope(scope);
  if (scopeHasNoScenes(scopeType, scopeTargetId)) return SKIPPED;
  await flushPendingSceneSaves();
  const payload = await buildMultiPayload(
    projectId,
    scopeType,
    scopeTargetId,
    model,
    "typo_detection",
    customKouetsu,
  );
  if (payload.scenes.length === 0) return SKIPPED;
  return launchMulti({
    project_id: projectId,
    effect_type: "typo_detection",
    scope_type: scopeType,
    scope_target_id: scopeTargetId,
    model,
    prompt_version: TYPO_PROMPT_VERSION,
    input_hash: payload.inputHash,
    scenes: payload.scenes,
    system_prompt: systemPrompt,
  });
}
