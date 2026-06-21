import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { resolveModelForPath } from "@/features/chat/modelRouting";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useEditorStore } from "@/features/editor/editorStore";
import {
  buildIntentDriftPayload,
  INTENT_DRIFT_PROMPT_VERSION,
} from "@/features/post-effect/intentDriftPayloadBuilder";
import {
  flushPendingSceneSaves,
  listAnnotationsForScene,
  runPostEffect,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import {
  appendIntentGuidance,
  appendKouetsuGuidance,
} from "@/features/post-effect/customInstruction";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import {
  PostEffectAnnotationPanel,
  INTENT_DRIFT_FILTER,
} from "@/features/post-effect/PostEffectAnnotationPanel";
import type { PostEffectDoneEvent } from "@/features/post-effect/types";

interface Props {
  sceneId: string;
}

export function CurrentSceneIntentDriftView({ sceneId }: Props) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const analysisGate = useAiGate("analysis");
  const { setAnnotations } = useAnnotationStore();
  const node = useTreeStore((s) => s.nodes.find((n) => n.id === sceneId));
  const intent = node?.intent ?? "";
  const hasIntent = intent.trim().length > 0;

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const run = useCallback(async () => {
    if (running || !hasIntent) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    const projectId = useTreeStore.getState().projectId;
    const lang = getCurrentProjectLanguage();
    // 機能別モデル(review ロール)を input_hash・記録・実呼び出しに一貫反映する。
    // 未設定なら既定チャットモデル（byte-identical）。
    const model =
      resolveModelForPath("post_effect_intent_drift") ??
      useAiSettingsStore.getState().settings?.model ??
      "gpt-4o-mini";
    const customKouetsu = useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", "");
    setRunning(true);
    try {
      await flushPendingSceneSaves(sceneId);
      const payload = await buildIntentDriftPayload(
        sceneId,
        model,
        intent,
        customKouetsu,
      );
      const basePrompt = getPromptCatalog(lang).postEffect.intentDriftSystem;
      const systemPrompt = appendIntentGuidance(
        appendKouetsuGuidance(basePrompt, customKouetsu),
        intent,
      );
      const outcome = await new Promise<{
        ok: boolean;
        e?: PostEffectDoneEvent;
        error?: string;
      }>((resolve) => {
        runPostEffect(
          {
            project_id: projectId,
            effect_type: "intent_drift",
            scope_type: "scene",
            scope_target_id: sceneId,
            model,
            model_override: resolveModelForPath("post_effect_intent_drift"),
            prompt_version: INTENT_DRIFT_PROMPT_VERSION,
            input_hash: payload.inputHash,
            codex_payload_json: "[]",
            scene_text: payload.sceneText,
            system_prompt: systemPrompt,
          },
          {
            onDone: (e) => resolve({ ok: true, e }),
            onError: (e) => resolve({ ok: false, error: e.error }),
          },
        ).catch((err) => resolve({ ok: false, error: String(err) }));
      });

      const resp = await listAnnotationsForScene({ projectId, sceneId });
      setAnnotations(sceneId, resp.annotations);
      const editor = useEditorStore.getState().editor;
      if (editor) applyAnnotationsToEditor(editor, resp.annotations);
      setRunning(false);

      if (!outcome.ok) {
        toast.error(t("kouetsu.intentDrift.executionFailed"), {
          description: outcome.error,
        });
        return;
      }
      if (outcome.e?.from_cache) {
        toast.info(t("kouetsu.consistency.fromCache"), {
          description: t("kouetsu.cache.notSent"),
        });
      } else if ((outcome.e?.annotation_count ?? 0) === 0) {
        toast.success(t("kouetsu.intentDrift.noIssues"));
      }
    } catch (e) {
      console.error("intent_drift launch error", e);
      setRunning(false);
      toast.error(t("kouetsu.intentDrift.launchFailed"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [running, sceneId, intent, hasIntent, setAnnotations, t]);

  const disabled =
    running || !hasIntent || analysisGate.presentation !== "enabled";
  const triggerTitle = !hasIntent
    ? t("kouetsu.currentScene.intentDriftHint")
    : (analysisGate.tooltip ?? t("kouetsu.currentScene.intentDriftTooltip"));

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("kouetsu.currentScene.intentDrift")}
        </span>
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={disabled}
            title={triggerTitle}
            onClick={() => void run()}
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
            <span>{t("kouetsu.currentScene.intentDriftDiagnosisButton")}</span>
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PostEffectAnnotationPanel
          sceneId={sceneId}
          categoryFilter={INTENT_DRIFT_FILTER}
          emptyLabel={t("kouetsu.intentDrift.empty")}
        />
      </div>
    </div>
  );
}
