/**
 * runners/timeline.ts — timeline_consistency（物語内時系列の整合性）の起動。
 * 本質的に全域なので常に project スコープの multi。story-time 未配置 0 件は skipped。
 */

import { getPromptCatalog } from "@/prompts/index";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import {
  appendKouetsuGuidance,
  appendTimelineGuidance,
} from "@/features/post-effect/customInstruction";
import { flushPendingSceneSaves } from "@/features/post-effect/api";
import {
  buildTimelinePayload,
  TIMELINE_CONSISTENCY_PROMPT_VERSION,
} from "@/features/post-effect/timelinePayloadBuilder";
import {
  BLOCKED,
  SKIPPED,
  commonParams,
  guardsPass,
  launchMulti,
  type KouetsuRunOutcome,
} from "./shared";

export async function runTimelineCheck(): Promise<KouetsuRunOutcome> {
  if (!guardsPass()) return BLOCKED;
  const { projectId, lang, model: base, customKouetsu } = commonParams();
  const ov = resolveRoleSendOverride("post_effect_timeline_consistency");
  const model = ov.model ?? base;
  await flushPendingSceneSaves();
  const payload = await buildTimelinePayload(
    "project",
    null,
    model,
    customKouetsu,
    { provider: ov.provider, endpointId: ov.endpointId },
  );
  // story-time 未配置で対象 0 件 → skipped（ビューが noScenesPlaced を表示）。
  if (payload.scenes.length === 0) return SKIPPED;
  return launchMulti({
    project_id: projectId,
    effect_type: "timeline_consistency",
    scope_type: "project",
    scope_target_id: null,
    model,
    model_override: ov.model,
    provider_override: ov.provider,
    api_variant_override: ov.apiVariant,
    endpoint_id_override: ov.endpointId,
    prompt_version: TIMELINE_CONSISTENCY_PROMPT_VERSION,
    input_hash: payload.inputHash,
    scenes: payload.scenes,
    system_prompt: appendTimelineGuidance(
      appendKouetsuGuidance(
        getPromptCatalog(lang).postEffect.timelineConsistencySystem,
        customKouetsu,
      ),
      payload.timelineContext,
    ),
  });
}
