import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { listAnnotationsForScene } from "@/features/post-effect/api";
import { runReviewCheck } from "@/features/kouetsu/runners";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import {
  PostEffectAnnotationPanel,
  REVIEW_FILTER,
} from "@/features/post-effect/PostEffectAnnotationPanel";
import { postEffectErrorToast } from "@/features/post-effect/errorToast";

interface Props {
  sceneId: string;
}

export function CurrentSceneReviewView({ sceneId }: Props) {
  const { t } = useTranslation();
  // 起動準備（payload 構築〜invoke）中のみのローカル状態。実行中かどうかは
  // runStore から導出する（ローカル useState だとタブ移動＝unmount で消え、
  // 実行中なのにボタンが通常表示へ戻る）。
  const [launching, setLaunching] = useState(false);
  // hook は短絡評価の右辺に置けないため、必ず無条件で呼ぶ。
  const storeRunning = useIsPostEffectRunning("review", "scene", sceneId);
  const running = launching || storeRunning;
  const analysisGate = useAiGate("analysis");
  const { setAnnotations } = useAnnotationStore();

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    setLaunching(true);
    try {
      // ガード → role override 解決 → storyContext → flush → payload build →
      // run 起動は runner に委譲する（全体チェックと同一経路 = input_hash /
      // キャッシュキーが分裂しない）。
      const outcome = await runReviewCheck({ type: "scene", sceneId });
      // ガード拒否は無反応（ガードが toast 済み）。
      if ("blocked" in outcome || "skipped" in outcome) {
        setLaunching(false);
        return;
      }
      const projectId = useTreeStore.getState().projectId;
      const resp = await listAnnotationsForScene({ projectId, sceneId });
      setAnnotations(sceneId, resp.annotations);
      const editor = useEditorStore.getState().editor;
      if (editor) applyAnnotationsToEditor(editor, resp.annotations);
      setLaunching(false);

      if (!outcome.ok) {
        postEffectErrorToast(
          t("kouetsu.review.executionFailed"),
          outcome.error,
        );
        return;
      }
      if (outcome.fromCache) {
        toast.info(t("kouetsu.consistency.fromCache"), {
          description: t("kouetsu.cache.notSent"),
        });
      } else if (outcome.count === 0) {
        toast.success(t("kouetsu.review.noFindings"));
      }
    } catch (e) {
      console.error("review launch error", e);
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.review.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
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
