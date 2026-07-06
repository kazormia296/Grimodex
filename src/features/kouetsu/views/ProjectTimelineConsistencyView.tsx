import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import { useEditorStore } from "@/features/editor/editorStore";
import {
  detectTimelineHygiene,
  type TimelineHygieneFinding,
} from "@/features/post-effect/timelineHygiene";
import {
  listAnnotationsForProject,
  listAnnotationsForScene,
} from "@/features/post-effect/api";
import { runTimelineCheck } from "@/features/kouetsu/runners";
import { AnnotationItem } from "@/features/post-effect/PostEffectAnnotationPanel";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import type { PostEffectAnnotation } from "@/features/post-effect/types";
import {
  postEffectErrorToast,
  postEffectPartialToast,
} from "@/features/post-effect/errorToast";
import { useResolvedKouetsuScope } from "@/features/kouetsu/useResolvedKouetsuScope";

/**
 * 物語内時系列の整合性 (timeline_consistency)。project スコープの multi run で
 * 各シーン本文を確立済タイムライン要約に照らし、矛盾を指摘する。あわせて LLM 不要の
 * 決定論データ衛生 (重複/不正キー) を live 表示する (ハイブリッドの検証可能な半分)。
 */
export function ProjectTimelineConsistencyView() {
  const { t } = useTranslation();
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);
  // 起動準備（payload 構築〜invoke）中のみのローカル状態。実行中かどうかは
  // runStore から導出する（ローカル useState だとタブ移動＝unmount で消え、
  // 実行中なのにボタンが通常表示へ戻る）。
  const [launching, setLaunching] = useState(false);
  // hook は短絡評価の右辺に置けないため、必ず無条件で呼ぶ。
  const storeRunning = useIsPostEffectRunning(
    "timeline_consistency",
    "project",
  );
  const runningAll = launching || storeRunning;
  const analysisGate = useAiGate("analysis");

  const projectId = useTreeStore((s) => s.projectId);
  const nodes = useTreeStore((s) => s.nodes);
  const { setAnnotations: storeSetAnnotations } = useAnnotationStore();
  // 時系列は本質的にプロジェクト全域なので folder/scene では絞らない（multi も
  // 常に project）。project 以外を選択中は「絞られない」ことをチップで明示する
  // （宙に浮いた folder anchor は resolve 段階で project へ倒れチップ非表示）。
  const isNonProjectScope = useResolvedKouetsuScope().type !== "project";

  const titleById = useMemo(
    () => new Map(nodes.map((n) => [n.id, n.title] as const)),
    [nodes],
  );
  const sceneTitle = (sceneId: string) => titleById.get(sceneId) ?? sceneId;

  // 決定論データ衛生 (live 再計算・LLM 不要)。
  const hygiene = useMemo<TimelineHygieneFinding[]>(
    () =>
      detectTimelineHygiene(
        nodes
          .filter((n) => n.nodeType === "scene")
          .map((n) => ({
            id: n.id,
            title: n.title,
            storyTimeOrder: n.storyTimeOrder,
          })),
      ),
    [nodes],
  );

  const reload = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) =>
        setAnnotations(
          resp.annotations.filter((a) => a.category === "timeline_anchor"),
        ),
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const afterRunAll = useCallback(
    async (activeSceneId: string | null) => {
      if (activeSceneId) {
        const resp = await listAnnotationsForScene({
          projectId,
          sceneId: activeSceneId,
        });
        storeSetAnnotations(activeSceneId, resp.annotations);
        const editor = useEditorStore.getState().editor;
        if (editor) applyAnnotationsToEditor(editor, resp.annotations);
      }
      const fresh = await listAnnotationsForProject({
        projectId,
        status: "open",
      });
      setAnnotations(
        fresh.annotations.filter((a) => a.category === "timeline_anchor"),
      );
    },
    [projectId, storeSetAnnotations],
  );

  const runAll = useCallback(async () => {
    if (runningAll) return;
    const activeSceneId = useTreeStore.getState().activeSceneId;
    setLaunching(true);
    try {
      const outcome = await runTimelineCheck();
      // ガード拒否は無反応（ガードが toast 済み）。
      if ("blocked" in outcome) {
        setLaunching(false);
        return;
      }
      // story-time 未配置で対象 0 件 → noScenesPlaced を案内。
      if ("skipped" in outcome) {
        setLaunching(false);
        toast.info(t("kouetsu.projectTimeline.noScenesPlaced"), {
          description: t("kouetsu.projectTimeline.placeScenesHint"),
        });
        return;
      }
      await afterRunAll(activeSceneId);
      setLaunching(false);
      if (!outcome.ok) {
        postEffectErrorToast(
          t("kouetsu.projectTimeline.checkFailed"),
          outcome.error,
        );
      } else {
        // 部分失敗 (一部シーンのみ解析失敗) は warning で通知 (成功分は保存済み)。
        postEffectPartialToast(outcome.summary);
      }
    } catch (e) {
      console.error("timeline multi launch error", e);
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.projectTimeline.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [runningAll, afterRunAll, t]);

  const groups = useMemo(() => {
    const acc = new Map<
      string,
      { sceneId: string; label: string; items: PostEffectAnnotation[] }
    >();
    for (const ann of annotations) {
      if (!ann.sceneId) continue;
      const g = acc.get(ann.sceneId) ?? {
        sceneId: ann.sceneId,
        label: sceneTitle(ann.sceneId),
        items: [],
      };
      g.items.push(ann);
      acc.set(ann.sceneId, g);
    }
    return [...acc.values()];
  }, [annotations, titleById]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {t("kouetsu.projectTimeline.header")}
          </span>
          {isNonProjectScope && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {t("kouetsu.scope.project")}
            </span>
          )}
        </div>
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={runningAll || analysisGate.presentation !== "enabled"}
            onClick={() => void runAll()}
            title={
              analysisGate.tooltip ?? t("kouetsu.projectTimeline.checkTooltip")
            }
            className={cn(
              "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
              "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {runningAll ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            <span>{t("kouetsu.projectTimeline.checkButton")}</span>
          </button>
        )}
      </div>

      {hygiene.length > 0 && (
        <div className="flex flex-col border-b border-border">
          <div className="flex items-center gap-1.5 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle size={12} />
            <span>{t("kouetsu.projectTimeline.dataInconsistency")}</span>
            <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] leading-none">
              {hygiene.length}
            </span>
          </div>
          <ul className="flex flex-col">
            {hygiene.map((h) => (
              <li key={`${h.kind}:${h.sceneId}`}>
                <button
                  type="button"
                  onClick={() =>
                    useTreeStore.getState().setActiveScene(h.sceneId)
                  }
                  className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <span className="truncate">{sceneTitle(h.sceneId)}</span>
                  <span className="ml-auto shrink-0 text-[10px]">
                    {h.kind === "duplicate_order"
                      ? t("kouetsu.projectTimeline.duplicateKey")
                      : t("kouetsu.projectTimeline.invalidKey")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Info size={16} />
          <span>{t("kouetsu.projectTimeline.empty")}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-0">
          {groups.map((g) => (
            <div key={g.sceneId} className="flex flex-col">
              <div
                role="button"
                tabIndex={0}
                onClick={() =>
                  useTreeStore.getState().setActiveScene(g.sceneId)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    useTreeStore.getState().setActiveScene(g.sceneId);
                }}
                className="sticky top-0 z-10 flex cursor-pointer items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50"
              >
                <span className="truncate">{g.label}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
                  {g.items.length}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2">
                {g.items.map((ann) => (
                  <AnnotationItem
                    key={ann.id}
                    ann={ann}
                    onStatusChange={(annotationId, status) => {
                      if (status === "open") return;
                      setAnnotations((prev) =>
                        prev.filter((a) => a.id !== annotationId),
                      );
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
