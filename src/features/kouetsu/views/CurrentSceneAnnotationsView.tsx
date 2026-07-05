import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import { useEditorStore } from "@/features/editor/editorStore";
import {
  buildConsistencyPayload,
  buildIntraPayload,
  CONSISTENCY_PROMPT_VERSION,
  INTRA_CONSISTENCY_PROMPT_VERSION,
} from "@/features/post-effect/consistencyPayloadBuilder";
import {
  flushPendingSceneSaves,
  listAnnotationsForScene,
  runPostEffect,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import { PostEffectAnnotationPanel } from "@/features/post-effect/PostEffectAnnotationPanel";
import { postEffectErrorToast } from "@/features/post-effect/errorToast";
import type {
  PostEffectAnnotation,
  PostEffectDoneEvent,
} from "@/features/post-effect/types";

interface Props {
  sceneId: string;
}

type RunKind = "consistency" | "intra" | "both";

type RunOutcome =
  | { kind: "ok"; effect: "consistency" | "intra"; e: PostEffectDoneEvent }
  | { kind: "err"; effect: "consistency" | "intra"; error: string };

function getDetectedByModel(ann: PostEffectAnnotation): string | undefined {
  let meta: Record<string, unknown> | undefined;
  try {
    meta =
      typeof ann.metadata === "string"
        ? (JSON.parse(ann.metadata) as Record<string, unknown>)
        : (ann.metadata as Record<string, unknown> | undefined);
  } catch {
    return undefined;
  }
  if (!meta) return undefined;
  const ref = (meta.codex_ref as Record<string, unknown> | undefined) ?? {};
  return (
    (ref.detected_by_model as string | undefined) ??
    (meta.detected_by_model as string | undefined)
  );
}

function countOpenByOtherModel(
  annotations: PostEffectAnnotation[],
  currentModels: readonly string[],
): { total: number; byModel: Map<string, number> } {
  // この run で実際に使ったモデル集合。機能別モデルにより consistency(review ロール)と
  // intra(既定)は別モデルになり得るため、いずれかに一致する注釈は「今回のモデル」と
  // みなして除外する（さもないと別モデル警告が誤発火する）。
  const current = new Set(currentModels.filter(Boolean));
  const byModel = new Map<string, number>();
  let total = 0;
  for (const ann of annotations) {
    if (ann.status !== "open") continue;
    const m = getDetectedByModel(ann);
    if (!m || current.has(m)) continue;
    byModel.set(m, (byModel.get(m) ?? 0) + 1);
    total += 1;
  }
  return { total, byModel };
}

export function CurrentSceneAnnotationsView({ sceneId }: Props) {
  const { t } = useTranslation();
  // 起動準備（payload 構築〜invoke）中のみのローカル状態。実行中かどうかは
  // runStore から導出する（ローカル useState だとタブ移動＝unmount で消え、
  // 実行中なのにボタンが通常表示へ戻る）。
  const [launching, setLaunching] = useState(false);
  // hook は短絡評価の右辺に置けないため、必ず無条件で呼ぶ。
  const consistencyRunning = useIsPostEffectRunning(
    "consistency",
    "scene",
    sceneId,
  );
  const intraRunning = useIsPostEffectRunning(
    "intra_scene_consistency",
    "scene",
    sceneId,
  );
  const storeRunning = consistencyRunning || intraRunning;
  const running = launching || storeRunning;
  const analysisGate = useAiGate("analysis");
  const { setAnnotations } = useAnnotationStore();

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const run = useCallback(
    async (kind: RunKind) => {
      if (running) return;
      if (blockIfPolicyOff("analysis")) return;
      if (blockIfUnlicensed()) return;
      const projectId = useTreeStore.getState().projectId;
      const lang = getCurrentProjectLanguage();
      const model =
        useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
      // consistency のみ review ロール対象。intra_scene_consistency は対象外なので
      // baseModel(=model)のまま（input_hash・実呼び出しを汚さない）。
      const ov = resolveRoleSendOverride("post_effect_consistency");
      const consistencyModel = ov.model ?? model;
      const customKouetsu = useSettingsStore
        .getState()
        .get("aiPrompt.custom.kouetsu", "");
      setLaunching(true);
      try {
        await flushPendingSceneSaves(sceneId);
        async function startConsistency(): Promise<RunOutcome> {
          try {
            const payload = await buildConsistencyPayload(
              projectId,
              sceneId,
              consistencyModel,
              customKouetsu,
              { provider: ov.provider, endpointId: ov.endpointId },
            );
            return await new Promise<RunOutcome>((resolve) => {
              runPostEffect(
                {
                  project_id: projectId,
                  effect_type: "consistency",
                  scope_type: "scene",
                  scope_target_id: sceneId,
                  model: consistencyModel,
                  model_override: ov.model,
                  provider_override: ov.provider,
                  api_variant_override: ov.apiVariant,
                  endpoint_id_override: ov.endpointId,
                  prompt_version: CONSISTENCY_PROMPT_VERSION,
                  input_hash: payload.inputHash,
                  codex_payload_json: payload.codexPayloadJson,
                  scene_text: payload.sceneText,
                  system_prompt: appendKouetsuGuidance(
                    getPromptCatalog(lang).postEffect.consistencySystem,
                    customKouetsu,
                  ),
                },
                {
                  onDone: (e) =>
                    resolve({ kind: "ok", effect: "consistency", e }),
                  onError: (e) =>
                    resolve({
                      kind: "err",
                      effect: "consistency",
                      error: e.error,
                    }),
                },
              ).catch((err) =>
                resolve({
                  kind: "err",
                  effect: "consistency",
                  error: String(err),
                }),
              );
            });
          } catch (err) {
            return { kind: "err", effect: "consistency", error: String(err) };
          }
        }

        async function startIntra(): Promise<RunOutcome> {
          try {
            const payload = await buildIntraPayload(
              sceneId,
              model,
              customKouetsu,
            );
            return await new Promise<RunOutcome>((resolve) => {
              runPostEffect(
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
                    getPromptCatalog(lang).postEffect.intraSystem,
                    customKouetsu,
                  ),
                },
                {
                  onDone: (e) => resolve({ kind: "ok", effect: "intra", e }),
                  onError: (e) =>
                    resolve({ kind: "err", effect: "intra", error: e.error }),
                },
              ).catch((err) =>
                resolve({ kind: "err", effect: "intra", error: String(err) }),
              );
            });
          } catch (err) {
            return { kind: "err", effect: "intra", error: String(err) };
          }
        }

        const tasks: Array<Promise<RunOutcome>> = [];
        if (kind === "consistency" || kind === "both")
          tasks.push(startConsistency());
        if (kind === "intra" || kind === "both") tasks.push(startIntra());
        const results = await Promise.all(tasks);

        const resp = await listAnnotationsForScene({ projectId, sceneId });
        setAnnotations(sceneId, resp.annotations);
        const editor = useEditorStore.getState().editor;
        if (editor) applyAnnotationsToEditor(editor, resp.annotations);
        setLaunching(false);

        const labelOf = (e: "consistency" | "intra") =>
          e === "consistency"
            ? t("kouetsu.consistency.codexLabel")
            : t("kouetsu.consistency.intraLabel");
        const errors = results.filter((r) => r.kind === "err");
        const oks = results.filter((r) => r.kind === "ok");

        if (errors.length === results.length) {
          toast.error(t("integrity.checkError"), {
            description: errors
              .map((r) => `${labelOf(r.effect)}: ${r.error}`)
              .join(" / "),
          });
          return;
        }
        if (errors.length > 0) {
          postEffectErrorToast(
            t("kouetsu.consistency.partialError", {
              effect: labelOf(errors[0]!.effect),
            }),
            errors[0]!.error,
          );
        } else {
          const allCache = oks.every((r) => r.e.from_cache === true);
          const totalCount = oks.reduce(
            (sum, r) => sum + r.e.annotation_count,
            0,
          );
          if (allCache) {
            toast.info(t("kouetsu.consistency.fromCache"), {
              description: t("kouetsu.cache.notSent"),
            });
          } else if (totalCount === 0) {
            toast.success(t("kouetsu.consistency.noIssues"));
          }
        }

        const otherModelCount = countOpenByOtherModel(resp.annotations, [
          consistencyModel,
          model,
        ]);
        if (otherModelCount.total > 0) {
          const sample = [...otherModelCount.byModel.entries()]
            .map(([m, n]) =>
              t("kouetsu.consistency.modelCount", { model: m, count: n }),
            )
            .join(", ");
          toast.info(
            t("kouetsu.consistency.otherModelWarning", {
              count: otherModelCount.total,
            }),
            { description: sample },
          );
        }
      } catch (e) {
        console.error("post-effect launch error", e);
        setLaunching(false);
        postEffectErrorToast(
          t("kouetsu.consistency.launchFailed"),
          e instanceof Error ? e.message : String(e),
        );
      }
    },
    [running, sceneId, setAnnotations, t],
  );

  const disabled = running || analysisGate.presentation !== "enabled";
  const triggerTitle =
    analysisGate.tooltip ?? t("kouetsu.consistency.runCurrentScene");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("kouetsu.currentScene.consistency")}
        </span>
        {/* analysis がポリシーで OFF のときは実行ボタンを隠す（パネルは残す）。 */}
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={disabled}
            title={triggerTitle}
            onClick={() => void run("both")}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
              "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            <span>{t("kouetsu.aiCheck")}</span>
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PostEffectAnnotationPanel sceneId={sceneId} />
      </div>
    </div>
  );
}
