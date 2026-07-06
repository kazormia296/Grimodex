/**
 * runners/consistency.ts — consistency(Codex) + intra_scene_consistency の起動。
 * 常に 2 effect を並行起動し {codex, intra} を返す（呼び出し側で集約トースト）。
 * consistency のみ review ロール override 対象。intra は baseModel のまま。
 *
 * scene パスは片側の payload build 失敗を outcome (ok:false) へ畳み、もう片側の
 * 結果を落とさない（CurrentScene ビューの片側失敗トーストが前提とする契約）。
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

export interface ConsistencyRunResult {
  codex: KouetsuRunOutcome;
  intra: KouetsuRunOutcome;
  /**
   * この run で実際に使ったモデル（codex = review ロール override 反映後 /
   * intra = 基底モデル）。ビューの「別モデル検出」警告が現行モデル集合を
   * runner と同一の導出で得るために返す（ガード拒否時は未設定）。
   */
  models?: { codex: string; intra: string };
}

export async function runConsistencyCheck(
  scope: KouetsuRunScope,
  hooks?: KouetsuRunHooks,
): Promise<ConsistencyRunResult> {
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

  const models = { codex: codexModel, intra: model };

  if (scope.type === "scene") {
    const sceneId = scope.sceneId;
    await flushPendingSceneSaves(sceneId);
    const [codex, intra] = await Promise.all([
      (async (): Promise<KouetsuRunOutcome> => {
        try {
          const payload = await buildConsistencyPayload(
            projectId,
            sceneId,
            codexModel,
            customKouetsu,
            codexRoute,
          );
          return await launchSingle(
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
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })(),
      (async (): Promise<KouetsuRunOutcome> => {
        try {
          const payload = await buildIntraPayload(
            sceneId,
            model,
            customKouetsu,
          );
          return await launchSingle(
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
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })(),
    ]);
    return { codex, intra, models };
  }

  const { scopeType, scopeTargetId } = multiScope(scope);
  if (scopeHasNoScenes(scopeType, scopeTargetId))
    return { codex: SKIPPED, intra: SKIPPED, models };
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
  return { codex, intra, models };
}
