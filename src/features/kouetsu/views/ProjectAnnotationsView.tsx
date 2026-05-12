import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookOpen, Info, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useEditorStore } from "@/features/editor/editorStore";
import {
  buildMultiPayload,
  CONSISTENCY_PROMPT_VERSION,
} from "@/features/post-effect/consistencyPayloadBuilder";
import {
  listAnnotationsForProject,
  listAnnotationsForScene,
  runPostEffectMulti,
} from "@/features/post-effect/api";
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

const SEVERITY_ICONS: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={13} className="text-destructive shrink-0" />,
  warning: <AlertTriangle size={13} className="text-yellow-500 shrink-0" />,
  suggestion: <Info size={13} className="text-blue-400 shrink-0" />,
  info: <Info size={13} className="text-muted-foreground shrink-0" />,
};

export function ProjectAnnotationsView() {
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningAll, setRunningAll] = useState(false);

  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const { setAnnotations: storeSetAnnotations } = useAnnotationStore();
  const groupBy = useKouetsuStore((s) => s.projectGroupBy);
  const setGroupBy = useKouetsuStore((s) => s.setProjectGroupBy);

  const sceneTitle = (sceneId: string) =>
    scenes.find((s) => s.id === sceneId)?.title ?? sceneId;

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) => setAnnotations(resp.annotations))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const runAll = useCallback(async () => {
    if (runningAll) return;
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    const sceneId = useTreeStore.getState().activeSceneId;
    setRunningAll(true);
    try {
      const payload = await buildMultiPayload(
        projectId,
        "project",
        null,
        model,
        "consistency",
      );
      if (payload.scenes.length === 0) {
        setRunningAll(false);
        return;
      }
      await runPostEffectMulti(
        {
          project_id: projectId,
          effect_type: "consistency",
          scope_type: "project",
          scope_target_id: null,
          model,
          prompt_version: CONSISTENCY_PROMPT_VERSION,
          input_hash: payload.inputHash,
          scenes: payload.scenes,
        },
        {
          onDone: async (e) => {
            if (sceneId) {
              const resp = await listAnnotationsForScene({
                projectId,
                sceneId,
              });
              storeSetAnnotations(sceneId, resp.annotations);
              const editor = useEditorStore.getState().editor;
              if (editor) applyAnnotationsToEditor(editor, resp.annotations);
            }
            const fresh = await listAnnotationsForProject({
              projectId,
              status: "open",
            });
            setAnnotations(fresh.annotations);
            setRunningAll(false);
            if (e.from_cache) {
              toast.info("前回と同じ内容のためキャッシュから読み込みました", {
                description: "AI には送信していません",
              });
            } else if (e.annotation_count === 0) {
              toast.success("全シーンで矛盾は見つかりませんでした");
            } else {
              toast.success(`${e.annotation_count} 件の矛盾候補を検出しました`);
            }
          },
          onError: (e) => {
            console.error("post-effect multi error", e.error);
            setRunningAll(false);
            toast.error("全シーン整合性チェックに失敗しました", {
              description: e.error,
            });
          },
        },
      );
    } catch (e) {
      console.error("post-effect multi launch error", e);
      setRunningAll(false);
      toast.error("全シーン整合性チェックを起動できませんでした", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [runningAll, projectId, storeSetAnnotations]);

  // ---- grouping ----
  type Group = {
    key: string;
    label: string;
    sceneId?: string;
    items: PostEffectAnnotation[];
  };

  const groups: Group[] = useMemo(() => {
    if (groupBy === "scene") {
      const acc = new Map<string, Group>();
      for (const ann of annotations) {
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
    for (const ann of annotations) {
      const parsed = parseAnnotationMeta(ann);
      const key = parsed.codex?.entryId ?? "__other__";
      const label =
        parsed.codex?.entryName ??
        (parsed.kind === "intra" ? "シーン内矛盾" : "未分類");
      const g = acc.get(key) ?? { key, label, items: [] };
      g.items.push(ann);
      acc.set(key, g);
    }
    return [...acc.values()];
    // sceneTitle depends on `scenes` so include it
  }, [annotations, groupBy, scenes]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">全シーン整合性</span>
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
              シーン別
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
              Codex別
            </button>
          </div>
        </div>
        <button
          aria-label="全シーンの整合性チェックを実行"
          title="全シーンの整合性チェックを実行"
          disabled={runningAll}
          onClick={runAll}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
            "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {runningAll ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <BookOpen size={12} />
          )}
          <span>実行</span>
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Info size={16} />
          <span>整合性の問題は見つかっていません</span>
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
