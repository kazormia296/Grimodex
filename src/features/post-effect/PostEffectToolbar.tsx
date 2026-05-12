import { useState, useCallback, useEffect } from "react";
import { ScanText, Loader2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiCapability } from "@/features/ai-policy/useAiCapability";
import { useAnnotationStore } from "./annotationStore";
import {
  buildConsistencyPayload,
  CONSISTENCY_PROMPT_VERSION,
} from "./consistencyPayloadBuilder";
import { runPostEffect, listAnnotationsForScene } from "./api";
import { applyAnnotationsToEditor } from "./applyAnnotationsToEditor";
import { ANNOTATION_REBUILD_META } from "./AnnotationPlugin";
import type { Editor } from "@tiptap/core";
import type { PostEffectAnnotation } from "./types";

interface Props {
  sceneId: string;
  editor: Editor | null;
}

/** annotation の metadata から detected_by_model を取り出す。 */
function getDetectedByModel(ann: PostEffectAnnotation): string | undefined {
  let meta: Record<string, unknown> | undefined;
  try {
    meta =
      typeof ann.metadata === "string"
        ? (JSON.parse(ann.metadata) as Record<string, unknown>)
        : (ann.metadata as Record<string, unknown> | undefined);
  } catch {
    return undefined;
  }
  if (!meta) return undefined;
  const ref = (meta.codex_ref as Record<string, unknown> | undefined) ?? {};
  return (
    (ref.detected_by_model as string | undefined) ??
    (meta.detected_by_model as string | undefined)
  );
}

/** open annotation のうち、現在 model と異なるモデルで検出されたものを集計 */
function countOpenByOtherModel(
  annotations: PostEffectAnnotation[],
  currentModel: string,
): { total: number; byModel: Map<string, number> } {
  const byModel = new Map<string, number>();
  let total = 0;
  for (const ann of annotations) {
    if (ann.status !== "open") continue;
    const m = getDetectedByModel(ann);
    if (!m || m === currentModel) continue;
    byModel.set(m, (byModel.get(m) ?? 0) + 1);
    total += 1;
  }
  return { total, byModel };
}

export function PostEffectToolbar({ sceneId, editor }: Props) {
  const [running, setRunning] = useState(false);
  const analysisCapability = useAiCapability("analysis");

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);
  const { showAnnotations, toggleShowAnnotations, setAnnotations } =
    useAnnotationStore();

  const run = useCallback(async () => {
    if (!editor || running) return;
    const projectId = useTreeStore.getState().projectId;
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    setRunning(true);
    try {
      const payload = await buildConsistencyPayload(projectId, sceneId, model);
      // terminal イベント (done/error) で listen は runPostEffect 側が
      // 自動 cleanup する。ハンドラ内で cleanup() を呼ぶ必要はない
      // (呼ぶと TDZ で ReferenceError → setRunning(false) 未到達 → spinner 永続)。
      await runPostEffect(
        {
          project_id: projectId,
          effect_type: "consistency",
          scope_type: "scene",
          scope_target_id: sceneId,
          model,
          prompt_version: CONSISTENCY_PROMPT_VERSION,
          input_hash: payload.inputHash,
          codex_payload_json: payload.codexPayloadJson,
          scene_text: payload.sceneText,
        },
        {
          onDone: async (e) => {
            const resp = await listAnnotationsForScene({ projectId, sceneId });
            setAnnotations(sceneId, resp.annotations);
            applyAnnotationsToEditor(editor, resp.annotations);
            setRunning(false);
            if (e.from_cache) {
              toast.info("前回と同じ内容のためキャッシュから読み込みました", {
                description: "AI には送信していません",
              });
            } else if (e.annotation_count === 0) {
              toast.success("矛盾は見つかりませんでした");
            }
            // 別モデルで検出された open annotation を集計し info 通知。
            // 過去 run で別 LLM が見つけた指摘がまだ残っていることを伝える
            // (自動 dismiss を廃止したのでユーザーが気付けない場合がある)
            const otherModelCount = countOpenByOtherModel(
              resp.annotations,
              model,
            );
            if (otherModelCount.total > 0) {
              const sample = [...otherModelCount.byModel.entries()]
                .map(([m, n]) => `${m}: ${n}件`)
                .join(", ");
              toast.info(
                `${otherModelCount.total} 件は別モデルで検出された指摘です`,
                {
                  description: sample,
                },
              );
            }
          },
          onError: (e) => {
            console.error("post-effect error", e.error);
            setRunning(false);
            toast.error("整合性チェックに失敗しました", {
              description: e.error,
            });
          },
        },
      );
    } catch (e) {
      console.error("post-effect launch error", e);
      setRunning(false);
      toast.error("整合性チェックを起動できませんでした", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [editor, running, sceneId, setAnnotations]);

  return (
    <div className="flex items-center gap-1">
      <button
        aria-label="このシーンの整合性チェック"
        title={
          analysisCapability.state === "disabled"
            ? analysisCapability.reason === "policy"
              ? "AIポリシーにより無効"
              : analysisCapability.reason === "no-model"
                ? "AIモデルが未選択です"
                : "AIが未設定です"
            : "このシーンの整合性チェック"
        }
        disabled={running || analysisCapability.state !== "enabled"}
        onClick={run}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded text-muted-foreground",
          "hover:bg-accent hover:text-accent-foreground",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        {running ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <ScanText size={15} />
        )}
      </button>
      <button
        aria-label={
          showAnnotations ? "アノテーション非表示" : "アノテーション表示"
        }
        title={showAnnotations ? "アノテーション非表示" : "アノテーション表示"}
        onClick={() => {
          toggleShowAnnotations();
          // Comment と同じ流儀: store トグル後に editor へ rebuild meta を投げて
          // Decoration を即時再構築させる。
          if (editor)
            editor.view.dispatch(
              editor.state.tr.setMeta(ANNOTATION_REBUILD_META, true),
            );
        }}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded",
          showAnnotations
            ? "text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
      >
        {showAnnotations ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
    </div>
  );
}
