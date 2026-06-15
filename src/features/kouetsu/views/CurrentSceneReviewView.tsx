import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useEditorStore } from "@/features/editor/editorStore";
import {
  buildReviewPayload,
  REVIEW_PROMPT_VERSION,
} from "@/features/post-effect/reviewPayloadBuilder";
import {
  flushPendingSceneSaves,
  listAnnotationsForScene,
  runPostEffect,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import {
  appendKouetsuGuidance,
  appendStoryContextGuidance,
} from "@/features/post-effect/customInstruction";
import { selectStoryContext } from "@/features/post-effect/storyContext";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import {
  PostEffectAnnotationPanel,
  REVIEW_FILTER,
} from "@/features/post-effect/PostEffectAnnotationPanel";
import type { PostEffectDoneEvent } from "@/features/post-effect/types";

interface Props {
  sceneId: string;
}

export function CurrentSceneReviewView({ sceneId }: Props) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const analysisGate = useAiGate("analysis");
  const { setAnnotations } = useAnnotationStore();

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    const projectId = useTreeStore.getState().projectId;
    const lang = getCurrentProjectLanguage();
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    const customKouetsu = useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", "");
    const storyContext = selectStoryContext(
      useTreeStore.getState().nodes,
      sceneId,
    );
    setRunning(true);
    try {
      await flushPendingSceneSaves(sceneId);
      const payload = await buildReviewPayload(
        sceneId,
        model,
        customKouetsu,
        storyContext,
      );
      const outcome = await new Promise<{
        ok: boolean;
        e?: PostEffectDoneEvent;
        error?: string;
      }>((resolve) => {
        runPostEffect(
          {
            project_id: projectId,
            effect_type: "review",
            scope_type: "scene",
            scope_target_id: sceneId,
            model,
            prompt_version: REVIEW_PROMPT_VERSION,
            input_hash: payload.inputHash,
            codex_payload_json: "[]",
            scene_text: payload.sceneText,
            system_prompt: appendStoryContextGuidance(
              appendKouetsuGuidance(
                getPromptCatalog(lang).postEffect.reviewSystem,
                customKouetsu,
              ),
              storyContext,
            ),
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
        toast.error(t("kouetsu.review.executionFailed"), {
          description: outcome.error,
        });
        return;
      }
      if (outcome.e?.from_cache) {
        toast.info(t("kouetsu.consistency.fromCache"), {
          description: t("kouetsu.cache.notSent"),
        });
      } else if ((outcome.e?.annotation_count ?? 0) === 0) {
        toast.success(t("kouetsu.review.noFindings"));
      }
    } catch (e) {
      console.error("review launch error", e);
      setRunning(false);
      toast.error(t("kouetsu.review.launchFailed"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [running, sceneId, setAnnotations, t]);

  const disabled = running || analysisGate.presentation !== "enabled";
  const triggerTitle =
    analysisGate.tooltip ?? t("kouetsu.review.currentTooltip");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("kouetsu.currentScene.review")}
        </span>
        {/* analysis がポリシーで OFF のときは実行ボタンを隠す（パネルは残す）。 */}
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
            <span>{t("kouetsu.aiReview")}</span>
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PostEffectAnnotationPanel
          sceneId={sceneId}
          categoryFilter={REVIEW_FILTER}
          emptyLabel={t("kouetsu.review.empty")}
        />
      </div>
    </div>
  );
}
