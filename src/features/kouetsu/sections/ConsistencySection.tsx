import { useCallback, useEffect, useState } from "react";
import { BookOpen, Loader2 } from "lucide-react";
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
  runPostEffectMulti,
  listAnnotationsForScene,
} from "@/features/post-effect/api";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import { PostEffectAnnotationPanel } from "@/features/post-effect/PostEffectAnnotationPanel";

export function ConsistencySection() {
  const [runningAll, setRunningAll] = useState(false);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const { setAnnotations } = useAnnotationStore();

  const runAll = useCallback(async () => {
    if (runningAll) return;
    const projectId = useTreeStore.getState().projectId;
    const sceneId = useTreeStore.getState().activeSceneId;
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
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
              setAnnotations(sceneId, resp.annotations);
              const editor = useEditorStore.getState().editor;
              if (editor) applyAnnotationsToEditor(editor, resp.annotations);
            }
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
  }, [runningAll, setAnnotations]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          全シーン整合性チェック
        </span>
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
      {activeSceneId ? (
        <PostEffectAnnotationPanel sceneId={activeSceneId} />
      ) : (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          シーンを選択してください
        </div>
      )}
    </div>
  );
}
