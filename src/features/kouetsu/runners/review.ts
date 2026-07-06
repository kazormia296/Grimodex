/**
 * runners/review.ts — review（編集者視点の診断レポート）の起動。
 * review ロールのモデル/プロバイダ override を反映する。scene は storyContext を注入。
 */

import { getPromptCatalog } from "@/prompts/index";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import {
  appendKouetsuGuidance,
  appendStoryContextGuidance,
} from "@/features/post-effect/customInstruction";
import { selectStoryContext } from "@/features/post-effect/storyContext";
import { flushPendingSceneSaves } from "@/features/post-effect/api";
import { buildMultiPayload } from "@/features/post-effect/consistencyPayloadBuilder";
import {
  buildReviewPayload,
  REVIEW_PROMPT_VERSION,
} from "@/features/post-effect/reviewPayloadBuilder";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  BLOCKED,
  SKIPPED,
  commonParams,
  guardsPass,
  launchMulti,
  launchSingle,
  multiScope,
  scopeHasNoScenes,
  type KouetsuRunHooks,
  type KouetsuRunOutcome,
  type KouetsuRunScope,
} from "./shared";

export async function runReviewCheck(
  scope: KouetsuRunScope,
  hooks?: KouetsuRunHooks,
): Promise<KouetsuRunOutcome> {
  if (!guardsPass()) return BLOCKED;
  const { projectId, lang, model: base, customKouetsu } = commonParams();
  const ov = resolveRoleSendOverride("post_effect_review");
  const model = ov.model ?? base;
  const route = { provider: ov.provider, endpointId: ov.endpointId };
  const overrides = {
    model_override: ov.model,
    provider_override: ov.provider,
    api_variant_override: ov.apiVariant,
    endpoint_id_override: ov.endpointId,
  };
  const reviewSystem = getPromptCatalog(lang).postEffect.reviewSystem;

  if (scope.type === "scene") {
    const storyContext = selectStoryContext(
      useTreeStore.getState().nodes,
      scope.sceneId,
    );
    await flushPendingSceneSaves(scope.sceneId);
    const payload = await buildReviewPayload(
      scope.sceneId,
      model,
      customKouetsu,
      storyContext,
      route,
    );
    return launchSingle(
      {
        project_id: projectId,
        effect_type: "review",
        scope_type: "scene",
        scope_target_id: scope.sceneId,
        model,
        ...overrides,
        prompt_version: REVIEW_PROMPT_VERSION,
        input_hash: payload.inputHash,
        codex_payload_json: "[]",
        scene_text: payload.sceneText,
        system_prompt: appendStoryContextGuidance(
          appendKouetsuGuidance(reviewSystem, customKouetsu),
          storyContext,
        ),
      },
      hooks,
    );
  }

  const { scopeType, scopeTargetId } = multiScope(scope);
  if (scopeHasNoScenes(scopeType, scopeTargetId)) return SKIPPED;
  await flushPendingSceneSaves();
  const payload = await buildMultiPayload(
    projectId,
    scopeType,
    scopeTargetId,
    model,
    "review",
    customKouetsu,
    route,
  );
  if (payload.scenes.length === 0) return SKIPPED;
  return launchMulti(
    {
      project_id: projectId,
      effect_type: "review",
      scope_type: scopeType,
      scope_target_id: scopeTargetId,
      model,
      ...overrides,
      prompt_version: REVIEW_PROMPT_VERSION,
      input_hash: payload.inputHash,
      scenes: payload.scenes,
      system_prompt: appendKouetsuGuidance(reviewSystem, customKouetsu),
    },
    hooks,
  );
}
