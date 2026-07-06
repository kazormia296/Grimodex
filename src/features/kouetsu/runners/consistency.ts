/**
 * runners/consistency.ts — consistency(Codex) + intra_scene_consistency の起動。
 * 常に 2 effect を並行起動し {codex, intra} を返す（呼び出し側で集約トースト）。
 * consistency のみ review ロール override 対象。intra は baseModel のまま。
 */

import { getPromptCatalog } from "@/prompts/index";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";
import { flushPendingSceneSaves } from "@/features/post-effect/api";
import {
  buildMultiPayload,
  buildConsistencyPayload,
  buildIntraPayload,
  CONSISTENCY_PROMPT_VERSION,
  INTRA_CONSISTENCY_PROMPT_VERSION,
} from "@/features/post-effect/consistencyPayloadBuilder";
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

export async function runConsistencyCheck(
  scope: KouetsuRunScope,
  hooks?: KouetsuRunHooks,
): Promise<{ codex: KouetsuRunOutcome; intra: KouetsuRunOutcome }> {
  if (!guardsPass()) return { codex: BLOCKED, intra: BLOCKED };
  const { projectId, lang, model, customKouetsu } = commonParams();
  const ov = resolveRoleSendOverride("post_effect_consistency");
  const codexModel = ov.model ?? model;
  const codexRoute = { provider: ov.provider, endpointId: ov.endpointId };
  const codexOverrides = {
    model_override: ov.model,
    provider_override: ov.provider,
    api_variant_override: ov.apiVariant,
    endpoint_id_override: ov.endpointId,
  };
  const catalog = getPromptCatalog(lang).postEffect;

  if (scope.type === "scene") {
    const sceneId = scope.sceneId;
    await flushPendingSceneSaves(sceneId);
    const [codex, intra] = await Promise.all([
      (async (): Promise<KouetsuRunOutcome> => {
        const payload = await buildConsistencyPayload(
          projectId,
          sceneId,
          codexModel,
          customKouetsu,
          codexRoute,
        );
        return launchSingle(
          {
            project_id: projectId,
            effect_type: "consistency",
            scope_type: "scene",
            scope_target_id: sceneId,
            model: codexModel,
            ...codexOverrides,
            prompt_version: CONSISTENCY_PROMPT_VERSION,
            input_hash: payload.inputHash,
            codex_payload_json: payload.codexPayloadJson,
            scene_text: payload.sceneText,
            system_prompt: appendKouetsuGuidance(
              catalog.consistencySystem,
              customKouetsu,
            ),
          },
          hooks,
        );
      })(),
      (async (): Promise<KouetsuRunOutcome> => {
        const payload = await buildIntraPayload(sceneId, model, customKouetsu);
        return launchSingle(
          {
            project_id: projectId,
            effect_type: "intra_scene_consistency",
            scope_type: "scene",
            scope_target_id: sceneId,
            model,
            prompt_version: INTRA_CONSISTENCY_PROMPT_VERSION,
            input_hash: payload.inputHash,
            codex_payload_json: "[]",
            scene_text: payload.sceneText,
            system_prompt: appendKouetsuGuidance(
              catalog.intraSystem,
              customKouetsu,
            ),
          },
          hooks,
        );
      })(),
    ]);
    return { codex, intra };
  }

  const { scopeType, scopeTargetId } = multiScope(scope);
  if (scopeHasNoScenes(scopeType, scopeTargetId))
    return { codex: SKIPPED, intra: SKIPPED };
  await flushPendingSceneSaves();

  const runOne = async (
    effect: "consistency" | "intra_scene_consistency",
  ): Promise<KouetsuRunOutcome> => {
    const isCodex = effect === "consistency";
    const effModel = isCodex ? codexModel : model;
    const payload = await buildMultiPayload(
      projectId,
      scopeType,
      scopeTargetId,
      effModel,
      effect,
      customKouetsu,
      isCodex ? codexRoute : undefined,
    );
    if (payload.scenes.length === 0) return SKIPPED;
    return launchMulti(
      {
        project_id: projectId,
        effect_type: effect,
        scope_type: scopeType,
        scope_target_id: scopeTargetId,
        model: effModel,
        ...(isCodex ? codexOverrides : {}),
        prompt_version: isCodex
          ? CONSISTENCY_PROMPT_VERSION
          : INTRA_CONSISTENCY_PROMPT_VERSION,
        input_hash: payload.inputHash,
        scenes: payload.scenes,
        system_prompt: appendKouetsuGuidance(
          isCodex ? catalog.consistencySystem : catalog.intraSystem,
          customKouetsu,
        ),
      },
      hooks,
    );
  };

  const [codex, intra] = await Promise.all([
    runOne("consistency"),
    runOne("intra_scene_consistency"),
  ]);
  return { codex, intra };
}
