import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { listAnnotationsForProject } from "@/features/post-effect/api";
import { getSceneIdsForScope } from "@/features/post-effect/consistencyPayloadBuilder";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import { runIntentDriftCheck } from "@/features/kouetsu/runners";
import { AnnotationItem } from "@/features/post-effect/PostEffectAnnotationPanel";
import type { PostEffectAnnotation } from "@/features/post-effect/types";
import {
  postEffectErrorToast,
  postEffectPartialToast,
} from "@/features/post-effect/errorToast";
import { useResolvedKouetsuScope } from "@/features/kouetsu/useResolvedKouetsuScope";

/**
 * プロジェクト全体の intent_anchor 指摘を一覧し、intent 付きシーンを直列に
 * 診断する。intent はシーン毎に input_hash へ畳み込まれるため multi 化できず、
 * runner が単発 run をシーン毎に直列実行する（未変更シーンは from_cache で即完了）。
 */
export function ProjectIntentDriftView() {
  const { t } = useTranslation();
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);
  // 起動準備（列挙〜直列 invoke）中のみのローカル状態。実行中かどうかは
  // runStore から導出する（ローカル useState だとタブ移動＝unmount で消え、
  // 実行中なのにボタンが通常表示へ戻る）。
  const [launching, setLaunching] = useState(false);
  const analysisGate = useAiGate("analysis");

  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const nodes = useTreeStore((s) => s.nodes);

  // folder スコープでは subtree 外シーンの指摘を隠す。
  // 宙に浮いた folder anchor は resolve 段階で project へ倒れる（絞り込み無効）。
  const kouetsuScope = useResolvedKouetsuScope();
  // 直列実行中はいずれかの scene run が running（scopeTargetId は跨ぐため未指定）。
  // hook は短絡評価の右辺に置けないため必ず無条件で呼ぶ。
  const storeRunning = useIsPostEffectRunning("intent_drift", "scene");
  const runningAll = launching || storeRunning;
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
        setAnnotations(
          resp.annotations.filter((a) => a.category === "intent_anchor"),
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

  const runAll = useCallback(async () => {
    if (runningAll) return;
    setLaunching(true);
    try {
      const outcome = await runIntentDriftCheck(
        kouetsuScope.type === "folder"
          ? { type: "folder", anchorId: kouetsuScope.anchorId }
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
        postEffectErrorToast(
          t("kouetsu.projectIntentDrift.failed"),
          outcome.error,
        );
      } else {
        // 部分失敗（一部シーンのみ診断失敗）は warning で通知（成功分は保存済み）。
        postEffectPartialToast(outcome.summary);
      }
    } catch (e) {
      console.error("intent_drift serial launch error", e);
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.projectIntentDrift.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [runningAll, kouetsuScope, reload, t]);

  const groups = useMemo(() => {
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
  }, [annotations, scenes, visibleSceneIds]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("kouetsu.projectIntentDrift.header")}
        </span>
        {/* analysis がポリシーで OFF のときは実行ボタンを隠す（パネルは残す）。 */}
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={runningAll || analysisGate.presentation !== "enabled"}
            onClick={() => void runAll()}
            title={
              analysisGate.tooltip ?? t("kouetsu.projectIntentDrift.runTooltip")
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
            <span>{t("kouetsu.aiCheck")}</span>
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
          <span>{t("kouetsu.intentDrift.empty")}</span>
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
