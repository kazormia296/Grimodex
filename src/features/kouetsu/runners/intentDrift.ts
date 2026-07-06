/**
 * runners/intentDrift.ts — intent_drift（作者宣言の狙い vs 本文のズレ）の起動。
 *
 * intent はシーン毎に system_prompt / input_hash へ畳み込まれるため multi 化
 * できない（設計書の確定逸脱）。folder/project スコープでも **単発 run をシーン
 * 毎に直列実行**する。per-scene の input_hash が効くため、intent と本文が未変更
 * のシーンは from_cache で即終わる。intent 未設定（空/空白のみ）のシーンはスキップ。
 *
 * per-scene の payload / system_prompt は CurrentSceneIntentDriftView とバイト
 * 同等（キャッシュキー不変が絶対条件 — current ビューのキャッシュが効き続ける）。
 */

import i18next from "i18next";
import { getPromptCatalog } from "@/prompts/index";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import {
  appendIntentGuidance,
  appendKouetsuGuidance,
} from "@/features/post-effect/customInstruction";
import { flushPendingSceneSaves } from "@/features/post-effect/api";
import { getSceneIdsForScope } from "@/features/post-effect/consistencyPayloadBuilder";
import {
  buildIntentDriftPayload,
  INTENT_DRIFT_PROMPT_VERSION,
} from "@/features/post-effect/intentDriftPayloadBuilder";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  BLOCKED,
  SKIPPED,
  commonParams,
  guardsPass,
  launchSingle,
  multiScope,
  type KouetsuRunOutcome,
  type KouetsuRunScope,
} from "./shared";

export interface IntentDriftRunOptions {
  /** 直列実行の各シーン完了ごとに (done, total) を通知する。 */
  onSceneProgress?: (done: number, total: number) => void;
  /** true を返すと残りシーンを起動しない（実行中の run は待つ）。 */
  isCancelled?: () => boolean;
  /**
   * 各シーンの run 起動直後に backend が採番した run_id を通知する。
   * 全体チェックが in-flight の 1 シーンだけを中止対象に絞るために使う。
   */
  onRunStarted?: (runId: string) => void;
}

/** scope 内の対象シーン ID を列挙する（scene はそのシーンのみ）。 */
function scopeSceneIds(scope: KouetsuRunScope): string[] {
  const nodes = useTreeStore.getState().nodes;
  if (scope.type === "scene") return [scope.sceneId];
  const { scopeType, scopeTargetId } = multiScope(scope);
  return getSceneIdsForScope(nodes, scopeType, scopeTargetId);
}

/** 部分失敗・途中キャンセルの summary を組み立てる（全成功なら undefined）。 */
function serialSummary(p: {
  total: number;
  failed: number;
  cancelled: boolean;
}): string | undefined {
  if (p.failed === 0 && !p.cancelled) return undefined;
  const parts: string[] = [];
  if (p.failed > 0) {
    parts.push(
      i18next.t("kouetsu.intentDrift.serialPartial", {
        defaultValue:
          "{{total}} 件中 {{failed}} 件のシーンで診断に失敗しました",
        failed: p.failed,
        total: p.total,
      }),
    );
  }
  if (p.cancelled) {
    parts.push(
      i18next.t("kouetsu.intentDrift.serialCancelled", {
        defaultValue: "途中で中止されました",
      }),
    );
  }
  return parts.join(" / ");
}

export async function runIntentDriftCheck(
  scope: KouetsuRunScope,
  opts?: IntentDriftRunOptions,
): Promise<KouetsuRunOutcome> {
  if (!guardsPass()) return BLOCKED;
  const { projectId, lang, model: base, customKouetsu } = commonParams();
  // review ロールでなく intent_drift 専用ロールの override を反映する
  // （CurrentSceneIntentDriftView と同じ経路 = input_hash がバイト同等）。
  const ov = resolveRoleSendOverride("post_effect_intent_drift");
  const model = ov.model ?? base;
  const route = { provider: ov.provider, endpointId: ov.endpointId };
  const overrides = {
    model_override: ov.model,
    provider_override: ov.provider,
    api_variant_override: ov.apiVariant,
    endpoint_id_override: ov.endpointId,
  };
  const basePrompt = getPromptCatalog(lang).postEffect.intentDriftSystem;

  // intent 非空のシーンだけを対象にする（treeStore ノードの intent フィールド。
  // payload には trim せず生の intent を渡す = current ビューとバイト同等）。
  const nodes = useTreeStore.getState().nodes;
  const targets: { id: string; intent: string }[] = [];
  for (const id of scopeSceneIds(scope)) {
    const intent = nodes.find((n) => n.id === id)?.intent ?? "";
    if (intent.trim().length > 0) targets.push({ id, intent });
  }
  if (targets.length === 0) return SKIPPED;

  const total = targets.length;
  let count = 0;
  let ran = 0;
  let cached = 0;
  let failed = 0;
  let firstError: string | undefined;
  let cancelled = false;

  for (const { id, intent } of targets) {
    if (opts?.isCancelled?.()) {
      cancelled = true;
      break;
    }
    await flushPendingSceneSaves(id);
    const payload = await buildIntentDriftPayload(
      id,
      model,
      intent,
      customKouetsu,
      route,
    );
    const systemPrompt = appendIntentGuidance(
      appendKouetsuGuidance(basePrompt, customKouetsu),
      intent,
    );
    const outcome = await launchSingle(
      {
        project_id: projectId,
        effect_type: "intent_drift",
        scope_type: "scene",
        scope_target_id: id,
        model,
        ...overrides,
        prompt_version: INTENT_DRIFT_PROMPT_VERSION,
        input_hash: payload.inputHash,
        codex_payload_json: "[]",
        scene_text: payload.sceneText,
        system_prompt: systemPrompt,
      },
      { onRunStarted: opts?.onRunStarted },
    );
    ran++;
    opts?.onSceneProgress?.(ran, total);
    if (!outcome.ok) {
      failed++;
      firstError ??= outcome.error;
    } else if ("count" in outcome) {
      count += outcome.count;
      if (outcome.fromCache) cached++;
    }
  }

  // 実行した全シーンが失敗ならエラー扱い（部分失敗は成功分を保存済み扱いで返す）。
  if (ran > 0 && failed === ran) {
    return { ok: false, error: firstError ?? "intent_drift failed" };
  }
  return {
    ok: true,
    fromCache: ran > 0 && cached === ran,
    count,
    summary: serialSummary({ total, failed, cancelled }),
  };
}
