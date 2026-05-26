import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Info,
  Loader2,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiCapability } from "@/features/ai-policy/useAiCapability";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useEditorStore } from "@/features/editor/editorStore";
import {
  buildMultiPayload,
  getSceneIdsForScope,
} from "@/features/post-effect/consistencyPayloadBuilder";
import { TYPO_PROMPT_VERSION } from "@/features/post-effect/typoPayloadBuilder";
import {
  listAnnotationsForProject,
  listAnnotationsForScene,
  runPostEffectMulti,
} from "@/features/post-effect/api";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import { getPromptCatalog } from "@/prompts/index";
import { applyTypoFixAndResolve } from "@/features/post-effect/typoFix";
import { parseAnnotationMeta } from "@/features/post-effect/annotationMeta";
import {
  ConfidenceBadge,
  ExpandedDetails,
  TypoChip,
  TypoContrastRow,
} from "@/features/post-effect/AnnotationDetails";
import type {
  PostEffectAnnotation,
  PostEffectSeverity,
} from "@/features/post-effect/types";

const SEVERITY_ICONS: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={13} className="text-destructive shrink-0" />,
  warning: <AlertTriangle size={13} className="text-yellow-500 shrink-0" />,
  suggestion: <Info size={13} className="text-blue-400 shrink-0" />,
  info: <Info size={13} className="text-muted-foreground shrink-0" />,
};

export function ProjectTypoView() {
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const analysisCapability = useAiCapability("analysis");

  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const { setAnnotations: storeSetAnnotations } = useAnnotationStore();

  const sceneTitle = (sceneId: string) =>
    scenes.find((s) => s.id === sceneId)?.title ?? sceneId;

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) =>
        setAnnotations(
          resp.annotations.filter((a) => a.category === "typo_anchor"),
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
        fresh.annotations.filter((a) => a.category === "typo_anchor"),
      );
    },
    [projectId, storeSetAnnotations],
  );

  const runAll = useCallback(async () => {
    if (runningAll) return;
    const { nodes } = useTreeStore.getState();
    if (getSceneIdsForScope(nodes, "project", null).length === 0) return;
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    const activeSceneId = useTreeStore.getState().activeSceneId;
    setRunningAll(true);

    try {
      const payload = await buildMultiPayload(
        projectId,
        "project",
        null,
        model,
        "typo_detection",
      );
      if (payload.scenes.length === 0) {
        setRunningAll(false);
        return;
      }
      const result = await new Promise<{
        ok: boolean;
        from_cache?: boolean;
        count?: number;
        error?: string;
      }>((resolve) => {
        runPostEffectMulti(
          {
            project_id: projectId,
            effect_type: "typo_detection",
            scope_type: "project",
            scope_target_id: null,
            model,
            prompt_version: TYPO_PROMPT_VERSION,
            input_hash: payload.inputHash,
            scenes: payload.scenes,
            system_prompt: getPromptCatalog("ja").postEffect.typoSystem,
          },
          {
            onDone: (e) =>
              resolve({
                ok: true,
                from_cache: e.from_cache,
                count: e.annotation_count,
              }),
            onError: (e) => resolve({ ok: false, error: e.error }),
          },
        ).catch((err) => resolve({ ok: false, error: String(err) }));
      });

      await afterRunAll(activeSceneId);
      setRunningAll(false);

      if (!result.ok) {
        toast.error("全シーン誤字脱字チェックに失敗しました", {
          description: result.error,
        });
        return;
      }
      if (result.from_cache) {
        toast.info("前回と同じ内容のためキャッシュから読み込みました", {
          description: "AI には送信していません",
        });
      } else if ((result.count ?? 0) === 0) {
        toast.success("全シーンで誤字脱字は見つかりませんでした");
      } else {
        toast.success(`${result.count} 件の誤字脱字候補を検出しました`);
      }
    } catch (e) {
      console.error("typo multi launch error", e);
      setRunningAll(false);
      toast.error("全シーン誤字脱字チェックを起動できませんでした", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [runningAll, projectId, afterRunAll]);

  const groups = useMemo(() => {
    const acc = new Map<string, PostEffectAnnotation[]>();
    for (const ann of annotations) {
      if (!ann.sceneId) continue;
      const arr = acc.get(ann.sceneId) ?? [];
      arr.push(ann);
      acc.set(ann.sceneId, arr);
    }
    return [...acc.entries()].map(([sceneId, items]) => ({
      sceneId,
      label: sceneTitle(sceneId),
      items,
    }));
    // sceneTitle depends on scenes
  }, [annotations, scenes]); // eslint-disable-line react-hooks/exhaustive-deps

  const disabled = runningAll || analysisCapability.state !== "enabled";
  const triggerTitle =
    analysisCapability.state === "disabled"
      ? analysisCapability.reason === "policy"
        ? "AIポリシーにより無効"
        : analysisCapability.reason === "no-model"
          ? "AIモデルが未選択です"
          : "AIが未設定です"
      : "全シーンの誤字脱字チェックを実行";

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">全シーン誤字脱字</span>
        <button
          type="button"
          disabled={disabled}
          title={triggerTitle}
          onClick={() => void runAll()}
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
          <span>AIチェック</span>
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Info size={16} />
          <span>誤字脱字は見つかっていません</span>
        </div>
      ) : (
        <div className="flex flex-col gap-0">
          {groups.map((g) => (
            <SceneGroupSection
              key={g.sceneId}
              sceneId={g.sceneId}
              label={g.label}
              items={g.items}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SceneGroupSection({
  sceneId,
  label,
  items,
}: {
  sceneId: string;
  label: string;
  items: PostEffectAnnotation[];
}) {
  return (
    <div className="flex flex-col">
      <div
        className="sticky top-0 z-10 flex cursor-pointer items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50"
        role="button"
        tabIndex={0}
        onClick={() => useTreeStore.getState().setActiveScene(sceneId)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ")
            useTreeStore.getState().setActiveScene(sceneId);
        }}
      >
        <span className="truncate">{label}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
          {items.length}
        </span>
      </div>
      <div className="flex flex-col gap-1 p-2">
        {items.map((ann) => (
          <TypoAnnotationRow key={ann.id} ann={ann} />
        ))}
      </div>
    </div>
  );
}

function TypoAnnotationRow({ ann }: { ann: PostEffectAnnotation }) {
  const { setFocusedAnnotationId, focusedAnnotationId } = useAnnotationStore();
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const editor = useEditorStore((s) => s.editor);
  const focused = focusedAnnotationId === ann.id;
  const parsed = parseAnnotationMeta(ann);
  const currentModel = useAiSettingsStore((s) => s.settings?.model);
  const severity = (ann.severity ?? "info") as PostEffectSeverity;
  // Fix は active scene 上でしか走らせない (別シーンの doc を読み込まずに
  // insertContentAt するのは不可能なため)。クリックで該当シーンに移った直後の
  // 同じレンダーで Fix を押すのは無理なので、まず scene 切替→もう一度押す UX
  // を期待する。
  const canFix =
    !!parsed.typo?.suggestion &&
    !!parsed.foundText &&
    !!editor &&
    ann.status === "open" &&
    activeSceneId === ann.sceneId;

  async function fix() {
    const result = await applyTypoFixAndResolve(editor, ann);
    if (!result.applied) {
      toast.error("置換できませんでした", {
        description: "該当箇所が本文中で見つからないか変更されています",
      });
    }
  }

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
        "group flex flex-col gap-1 rounded border px-2 py-1.5 text-xs cursor-pointer select-none transition-colors",
        focused
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:border-muted-foreground/40 hover:bg-accent/30",
      )}
    >
      <div className="flex items-start gap-1.5">
        {SEVERITY_ICONS[severity]}
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {parsed.typo && <TypoChip category={parsed.typo.category} />}
          {parsed.confidence && <ConfidenceBadge level={parsed.confidence} />}
        </div>
        {canFix && (
          <button
            aria-label="Quick Fix (suggestion を適用)"
            title={`「${parsed.typo!.suggestion}」に置き換える`}
            onClick={(e) => {
              e.stopPropagation();
              void fix();
            }}
            className="shrink-0 rounded p-0.5 text-blue-600 opacity-0 transition-opacity hover:bg-blue-500/20 group-hover:opacity-100"
          >
            <Wrench size={13} />
          </button>
        )}
      </div>
      {parsed.typo && (
        <TypoContrastRow
          found={parsed.foundText}
          suggestion={parsed.typo.suggestion}
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
