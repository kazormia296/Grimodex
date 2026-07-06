import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, Loader2, Sparkles, XCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { getSceneIdsForScope } from "@/features/post-effect/consistencyPayloadBuilder";
import {
  listAnnotationsForProject,
  listAnnotationsForScene,
} from "@/features/post-effect/api";
import { runConsistencyCheck } from "@/features/kouetsu/runners";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import { parseAnnotationMeta } from "@/features/post-effect/annotationMeta";
import {
  CodexChip,
  ConfidenceBadge,
  ContrastRow,
  ExpandedDetails,
} from "@/features/post-effect/AnnotationDetails";
import type {
  PostEffectAnnotation,
  PostEffectSeverity,
} from "@/features/post-effect/types";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useResolvedKouetsuScope } from "@/features/kouetsu/useResolvedKouetsuScope";
import {
  postEffectErrorToast,
  postEffectPartialToast,
} from "@/features/post-effect/errorToast";

const SEVERITY_ICONS: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={13} className="text-destructive shrink-0" />,
  warning: <AlertTriangle size={13} className="text-yellow-500 shrink-0" />,
  suggestion: <Info size={13} className="text-blue-400 shrink-0" />,
  info: <Info size={13} className="text-muted-foreground shrink-0" />,
};

export function ProjectAnnotationsView() {
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
  const { setAnnotations: storeSetAnnotations } = useAnnotationStore();
  const groupBy = useKouetsuStore((s) => s.projectGroupBy);
  const setGroupBy = useKouetsuStore((s) => s.setProjectGroupBy);

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
  const consistencyRunning = useIsPostEffectRunning(
    "consistency",
    scopeType,
    scopeTargetId ?? undefined,
  );
  const intraRunning = useIsPostEffectRunning(
    "intra_scene_consistency",
    scopeType,
    scopeTargetId ?? undefined,
  );
  const storeRunning = consistencyRunning || intraRunning;
  const runningAll = launching || storeRunning;
  // 表示フィルタ用の subtree scene 集合（folder 以外は null = 絞り込みなし）。
  const visibleSceneIds = useMemo(() => {
    if (kouetsuScope.type !== "folder") return null;
    return new Set(getSceneIdsForScope(nodes, "folder", kouetsuScope.anchorId));
  }, [kouetsuScope, nodes]);

  const sceneTitle = (sceneId: string) =>
    scenes.find((s) => s.id === sceneId)?.title ?? sceneId;

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) =>
        // 整合性 (consistency / intra) のみ。typo は ProjectTypoView で別表示。
        setAnnotations(
          resp.annotations.filter((a) => a.category !== "typo_anchor"),
        ),
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  /** 全完了後の共通後処理: editor反映 + プロジェクト一覧再取得 */
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
      setAnnotations(fresh.annotations);
    },
    [projectId, storeSetAnnotations],
  );

  const runMulti = useCallback(async () => {
    if (runningAll) return;
    const activeSceneId = useTreeStore.getState().activeSceneId;
    setLaunching(true);
    try {
      const { codex, intra } = await runConsistencyCheck(
        scopeType === "folder"
          ? { type: "folder", anchorId: scopeTargetId as string }
          : { type: "project" },
      );
      // ガード拒否は無反応（ガードが toast 済み）。
      if ("blocked" in codex) {
        setLaunching(false);
        return;
      }
      // 対象 0 件 (両 effect skipped) は静かに終了 (旧 getSceneIds 空と同じ)。
      if ("skipped" in codex && "skipped" in intra) {
        setLaunching(false);
        return;
      }
      await afterRunAll(activeSceneId);
      setLaunching(false);

      const codexCount = codex.ok && "count" in codex ? codex.count : 0;
      const intraCount = intra.ok && "count" in intra ? intra.count : 0;
      const codexCache = codex.ok && "fromCache" in codex && codex.fromCache;
      const intraCache = intra.ok && "fromCache" in intra && intra.fromCache;

      const errors: string[] = [];
      if (!codex.ok) errors.push(`Codex: ${codex.error}`);
      if (!intra.ok)
        errors.push(`${t("kouetsu.consistency.intraPrefix")}: ${intra.error}`);
      // 部分失敗 (一部シーンのみ解析失敗) の summary。片方が完全失敗した場合でも
      // もう片方の部分失敗を握り潰さないよう先に集めておく。
      const partialSummaries: string[] = [];
      if (codex.ok && "summary" in codex && codex.summary)
        partialSummaries.push(`Codex: ${codex.summary}`);
      if (intra.ok && "summary" in intra && intra.summary)
        partialSummaries.push(
          `${t("kouetsu.consistency.intraPrefix")}: ${intra.summary}`,
        );

      if (errors.length === 2) {
        postEffectErrorToast(
          t("kouetsu.projectAnnotations.checkFailed"),
          errors.join(" / "),
        );
        return;
      }
      if (errors.length === 1) {
        const label = !codex.ok
          ? t("kouetsu.consistency.codexLabel")
          : t("kouetsu.consistency.intraLabel");
        postEffectErrorToast(
          t("kouetsu.projectAnnotations.checkFailedPartial", { label }),
          errors[0],
        );
        // 生き残った側が部分失敗していた場合はその警告も出す。
        if (partialSummaries.length > 0) {
          postEffectPartialToast(partialSummaries.join(" / "));
        }
        return;
      }
      if (partialSummaries.length > 0) {
        postEffectPartialToast(partialSummaries.join(" / "));
        return;
      }
      const bothCache = codexCache && intraCache;
      const totalCount = codexCount + intraCount;
      if (bothCache) {
        toast.info(t("kouetsu.consistency.fromCache"), {
          description: t("kouetsu.cache.notSent"),
        });
      } else if (totalCount === 0) {
        toast.success(t("kouetsu.projectAnnotations.noIssues"));
      } else {
        toast.success(
          t("kouetsu.consistency.foundCount", { count: totalCount }),
          {
            description: t("kouetsu.consistency.conflictBreakdown", {
              consCount: codexCount,
              intraCount,
            }),
          },
        );
      }
    } catch (e) {
      console.error("post-effect multi launch error", e);
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.projectAnnotations.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [runningAll, afterRunAll, t, scopeType, scopeTargetId]);

  // ---- grouping ----
  type Group = {
    key: string;
    label: string;
    sceneId?: string;
    items: PostEffectAnnotation[];
  };

  const groups: Group[] = useMemo(() => {
    // folder スコープでは subtree 外シーンの指摘をグルーピング前に隠す
    // （project 時は素通し）。scene / codex どちらのグルーピングにも効かせる。
    const source = visibleSceneIds
      ? annotations.filter((a) => a.sceneId && visibleSceneIds.has(a.sceneId))
      : annotations;
    if (groupBy === "scene") {
      const acc = new Map<string, Group>();
      for (const ann of source) {
        if (!ann.sceneId) continue;
        const g = acc.get(ann.sceneId) ?? {
          key: ann.sceneId,
          label: sceneTitle(ann.sceneId),
          sceneId: ann.sceneId,
          items: [],
        };
        g.items.push(ann);
        acc.set(ann.sceneId, g);
      }
      return [...acc.values()];
    }
    // codex grouping
    const acc = new Map<string, Group>();
    for (const ann of source) {
      const parsed = parseAnnotationMeta(ann);
      const key = parsed.codex?.entryId ?? "__other__";
      const label =
        parsed.codex?.entryName ??
        (parsed.kind === "intra"
          ? t("kouetsu.consistency.intraLabel")
          : t("kouetsu.consistency.unclassified"));
      const g = acc.get(key) ?? { key, label, items: [] };
      g.items.push(ann);
      acc.set(key, g);
    }
    return [...acc.values()];
    // sceneTitle depends on `scenes` so include it
  }, [annotations, groupBy, scenes, visibleSceneIds]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {t("kouetsu.projectAnnotations.header")}
          </span>
          <div className="flex items-center rounded border border-border bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => setGroupBy("scene")}
              className={cn(
                "rounded px-1.5 py-0 text-[10px]",
                groupBy === "scene"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("kouetsu.projectAnnotations.groupByScene")}
            </button>
            <button
              type="button"
              onClick={() => setGroupBy("codex")}
              className={cn(
                "rounded px-1.5 py-0 text-[10px]",
                groupBy === "codex"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("kouetsu.projectAnnotations.groupByCodex")}
            </button>
          </div>
        </div>
        {/* analysis がポリシーで OFF のときは実行ボタンを隠す（パネルは残す）。 */}
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={runningAll || analysisGate.presentation !== "enabled"}
            onClick={() => void runMulti()}
            title={
              analysisGate.tooltip ?? t("kouetsu.consistency.runAllScenes")
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
          <span>{t("kouetsu.projectAnnotations.empty")}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-0">
          {groups.map((g) => (
            <GroupSection
              key={g.key}
              group={g}
              groupBy={groupBy}
              sceneTitle={sceneTitle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupSection({
  group,
  groupBy,
  sceneTitle,
}: {
  group: {
    key: string;
    label: string;
    sceneId?: string;
    items: PostEffectAnnotation[];
  };
  groupBy: "scene" | "codex";
  sceneTitle: (sceneId: string) => string;
}) {
  const onHeaderClick =
    groupBy === "scene" && group.sceneId
      ? () => useTreeStore.getState().setActiveScene(group.sceneId!)
      : undefined;

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground",
          onHeaderClick && "cursor-pointer hover:bg-muted/50",
        )}
        role={onHeaderClick ? "button" : undefined}
        tabIndex={onHeaderClick ? 0 : undefined}
        onClick={onHeaderClick}
        onKeyDown={(e) => {
          if (onHeaderClick && (e.key === "Enter" || e.key === " "))
            onHeaderClick();
        }}
      >
        <span className="truncate">{group.label}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
          {group.items.length}
        </span>
      </div>
      <div className="flex flex-col gap-1 p-2">
        {group.items.map((ann) => (
          <AnnotationRow
            key={ann.id}
            ann={ann}
            showSceneLabel={groupBy === "codex"}
            sceneTitle={sceneTitle}
          />
        ))}
      </div>
    </div>
  );
}

function AnnotationRow({
  ann,
  showSceneLabel,
  sceneTitle,
}: {
  ann: PostEffectAnnotation;
  showSceneLabel: boolean;
  sceneTitle: (sceneId: string) => string;
}) {
  const { setFocusedAnnotationId, focusedAnnotationId } = useAnnotationStore();
  const focused = focusedAnnotationId === ann.id;
  const severity = (ann.severity ?? "info") as PostEffectSeverity;
  const parsed = parseAnnotationMeta(ann);
  const currentModel = useAiSettingsStore((s) => s.settings?.model);
  const showTitle = parsed.kind === "intra";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (ann.sceneId) useTreeStore.getState().setActiveScene(ann.sceneId);
        setFocusedAnnotationId(focused ? null : ann.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          if (ann.sceneId) useTreeStore.getState().setActiveScene(ann.sceneId);
          setFocusedAnnotationId(focused ? null : ann.id);
        }
      }}
      className={cn(
        "flex flex-col gap-1 rounded border px-2 py-1.5 text-xs cursor-pointer select-none",
        "transition-colors",
        focused
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:border-muted-foreground/40 hover:bg-accent/30",
      )}
    >
      <div className="flex items-start gap-1.5">
        {SEVERITY_ICONS[severity]}
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {parsed.codex && <CodexChip codex={parsed.codex} />}
          {parsed.confidence && <ConfidenceBadge level={parsed.confidence} />}
          {showSceneLabel && ann.sceneId && (
            <span className="truncate text-[10px] text-muted-foreground">
              {sceneTitle(ann.sceneId)}
            </span>
          )}
          {showTitle && (
            <p className="basis-full leading-snug">{ann.content}</p>
          )}
        </div>
      </div>
      {parsed.codex && (
        <ContrastRow
          expected={parsed.codex.expectedValue}
          found={parsed.codex.foundValue}
        />
      )}
      {ann.textSnapshot && (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-2 text-muted-foreground line-clamp-2">
          {ann.textSnapshot}
        </blockquote>
      )}
      {focused && (
        <ExpandedDetails parsed={parsed} currentModel={currentModel} />
      )}
    </div>
  );
}
