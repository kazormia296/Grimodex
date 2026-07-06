import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { getSceneIdsForScope } from "@/features/post-effect/consistencyPayloadBuilder";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import { listAnnotationsForProject } from "@/features/post-effect/api";
import { runReviewCheck } from "@/features/kouetsu/runners";
import { AnnotationItem } from "@/features/post-effect/PostEffectAnnotationPanel";
import type { PostEffectAnnotation } from "@/features/post-effect/types";
import {
  postEffectErrorToast,
  postEffectPartialToast,
} from "@/features/post-effect/errorToast";
import { useResolvedKouetsuScope } from "@/features/kouetsu/useResolvedKouetsuScope";

export function ProjectReviewView() {
  const { t } = useTranslation();
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);
  // 起動準備（payload 構築〜invoke）中のみのローカル状態。実行中かどうかは
  // runStore から導出する（ローカル useState だとタブ移動＝unmount で消え、
  // 実行中なのにボタンが通常表示へ戻る）。
  const [launching, setLaunching] = useState(false);
  const analysisGate = useAiGate("analysis");

  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const nodes = useTreeStore((s) => s.nodes);

  // 校閲スコープ。folder のとき subtree に絞る。scene / project は project 扱い。
  // 宙に浮いた folder anchor は resolve 段階で project へ倒れる。
  const kouetsuScope = useResolvedKouetsuScope();
  const scopeType =
    kouetsuScope.type === "folder" ? ("folder" as const) : ("project" as const);
  const scopeTargetId =
    kouetsuScope.type === "folder" ? kouetsuScope.anchorId : null;
  // hook は短絡評価の右辺に置けないため、必ず無条件で呼ぶ。scopeType/
  // scopeTargetId 導出後に呼ぶことで folder run を正しく区別する（run
  // 実行中に unmount→remount してもスピナーが消えない）。
  const storeRunning = useIsPostEffectRunning(
    "review",
    scopeType,
    scopeTargetId ?? undefined,
  );
  const runningAll = launching || storeRunning;
  // 表示フィルタ用の subtree scene 集合（folder 以外は null = 絞り込みなし）。
  const visibleSceneIds = useMemo(() => {
    if (kouetsuScope.type !== "folder") return null;
    return new Set(getSceneIdsForScope(nodes, "folder", kouetsuScope.anchorId));
  }, [kouetsuScope, nodes]);

  const sceneTitle = (sceneId: string) =>
    scenes.find((s) => s.id === sceneId)?.title ?? sceneId;

  const reload = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) =>
        setAnnotations(resp.annotations.filter((a) => a.category === "review")),
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

  const runAll = useCallback(async () => {
    if (runningAll) return;
    setLaunching(true);
    try {
      const outcome = await runReviewCheck(
        scopeType === "folder"
          ? { type: "folder", anchorId: scopeTargetId as string }
          : { type: "project" },
      );
      // ガード拒否 / 対象 0 件は無反応（runner・ガードが処理済み）。
      if ("skipped" in outcome || "blocked" in outcome) {
        setLaunching(false);
        return;
      }
      reload();
      setLaunching(false);
      if (!outcome.ok) {
        postEffectErrorToast(t("kouetsu.projectReview.failed"), outcome.error);
      } else {
        // 部分失敗 (一部シーンのみ解析失敗) は warning で通知 (成功分は保存済み)。
        postEffectPartialToast(outcome.summary);
      }
    } catch (e) {
      console.error("review multi launch error", e);
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.projectReview.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [runningAll, reload, scopeType, scopeTargetId, t]);

  const groups = useMemo(() => {
    // folder スコープでは subtree 外シーンの指摘を隠す（project 時は素通し）。
    const source = visibleSceneIds
      ? annotations.filter((a) => a.sceneId && visibleSceneIds.has(a.sceneId))
      : annotations;
    const acc = new Map<
      string,
      { sceneId: string; label: string; items: PostEffectAnnotation[] }
    >();
    for (const ann of source) {
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
    // sceneTitle depends on `scenes`
  }, [annotations, scenes, visibleSceneIds]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("kouetsu.projectReview.header")}
        </span>
        {/* analysis がポリシーで OFF のときは実行ボタンを隠す（パネルは残す）。 */}
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={runningAll || analysisGate.presentation !== "enabled"}
            onClick={() => void runAll()}
            title={analysisGate.tooltip ?? t("kouetsu.review.projectTooltip")}
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
            <span>{t("kouetsu.aiReview")}</span>
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Info size={16} />
          <span>{t("kouetsu.review.empty")}</span>
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
                  <AnnotationItem key={ann.id} ann={ann} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
