/**
 * runners/metaStructure.ts — meta_structure（プロット構造・ペーシングの俯瞰診断）の起動。
 * scene = 単発（storyContext 注入） / folder|project = multi。結果は scene_lens_data。
 */

import { getPromptCatalog } from "@/prompts/index";
import {
  appendKouetsuGuidance,
  appendStoryContextGuidance,
} from "@/features/post-effect/customInstruction";
import { selectStoryContext } from "@/features/post-effect/storyContext";
import { flushPendingSceneSaves } from "@/features/post-effect/api";
import { buildMultiPayload } from "@/features/post-effect/consistencyPayloadBuilder";
import {
  buildMetaStructurePayload,
  META_STRUCTURE_PROMPT_VERSION,
} from "@/features/post-effect/metaStructurePayloadBuilder";
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

export async function runMetaStructureCheck(
  scope: KouetsuRunScope,
  hooks?: KouetsuRunHooks,
): Promise<KouetsuRunOutcome> {
  if (!guardsPass()) return BLOCKED;
  const { projectId, lang, model, customKouetsu } = commonParams();
  const metaSystem = getPromptCatalog(lang).postEffect.metaStructureSystem;

  if (scope.type === "scene") {
    const storyContext = selectStoryContext(
      useTreeStore.getState().nodes,
      scope.sceneId,
    );
    await flushPendingSceneSaves(scope.sceneId);
    const payload = await buildMetaStructurePayload(
      scope.sceneId,
      model,
      customKouetsu,
      storyContext,
    );
    return launchSingle(
      {
        project_id: projectId,
        effect_type: "meta_structure",
        scope_type: "scene",
        scope_target_id: scope.sceneId,
        model,
        prompt_version: META_STRUCTURE_PROMPT_VERSION,
        input_hash: payload.inputHash,
        codex_payload_json: "[]",
        scene_text: payload.sceneText,
        system_prompt: appendStoryContextGuidance(
          appendKouetsuGuidance(metaSystem, customKouetsu),
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
    "meta_structure",
    customKouetsu,
  );
  if (payload.scenes.length === 0) return SKIPPED;
  return launchMulti(
    {
      project_id: projectId,
      effect_type: "meta_structure",
      scope_type: scopeType,
      scope_target_id: scopeTargetId,
      model,
      prompt_version: META_STRUCTURE_PROMPT_VERSION,
      input_hash: payload.inputHash,
      scenes: payload.scenes,
      system_prompt: appendKouetsuGuidance(metaSystem, customKouetsu),
    },
    hooks,
  );
}
