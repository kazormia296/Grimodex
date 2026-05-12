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
  buildIntraPayload,
  CONSISTENCY_PROMPT_VERSION,
  INTRA_CONSISTENCY_PROMPT_VERSION,
} from "./consistencyPayloadBuilder";
import { runPostEffect, listAnnotationsForScene } from "./api";
import { applyAnnotationsToEditor } from "./applyAnnotationsToEditor";
import { ANNOTATION_REBUILD_META } from "./AnnotationPlugin";
import type { Editor } from "@tiptap/core";
import type { PostEffectAnnotation, PostEffectDoneEvent } from "./types";

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

type RunOutcome =
  | { kind: "ok"; effect: "consistency" | "intra"; e: PostEffectDoneEvent }
  | { kind: "err"; effect: "consistency" | "intra"; error: string };

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
      const [consPayload, intraPayload] = await Promise.all([
        buildConsistencyPayload(projectId, sceneId, model),
        buildIntraPayload(sceneId, model),
      ]);

      // runPostEffect は starter() 完了で即 resolve するため、terminal (done/error) を
      // 待つには手動 Promise を組む必要がある。onError も resolve (reject しない) して
      // Promise.all が片方失敗で全体 reject されないようにする。
      function startOne(effect: "consistency" | "intra"): Promise<RunOutcome> {
        return new Promise((resolve) => {
          const req =
            effect === "consistency"
              ? {
                  project_id: projectId,
                  effect_type: "consistency" as const,
                  scope_type: "scene" as const,
                  scope_target_id: sceneId,
                  model,
                  prompt_version: CONSISTENCY_PROMPT_VERSION,
                  input_hash: consPayload.inputHash,
                  codex_payload_json: consPayload.codexPayloadJson,
                  scene_text: consPayload.sceneText,
                }
              : {
                  project_id: projectId,
                  effect_type: "intra_scene_consistency" as const,
                  scope_type: "scene" as const,
                  scope_target_id: sceneId,
                  model,
                  prompt_version: INTRA_CONSISTENCY_PROMPT_VERSION,
                  input_hash: intraPayload.inputHash,
                  codex_payload_json: "[]",
                  scene_text: intraPayload.sceneText,
                };
          runPostEffect(req, {
            onDone: (e) => resolve({ kind: "ok", effect, e }),
            onError: (e) => resolve({ kind: "err", effect, error: e.error }),
          }).catch((err) =>
            resolve({ kind: "err", effect, error: String(err) }),
          );
        });
      }

      const [resA, resB] = await Promise.all([
        startOne("consistency"),
        startOne("intra"),
      ]);

      // 全完了後に 1 回だけ再フェッチ & editor 反映
      const resp = await listAnnotationsForScene({ projectId, sceneId });
      setAnnotations(sceneId, resp.annotations);
      applyAnnotationsToEditor(editor, resp.annotations);
      setRunning(false);

      // toast 集約
      const errors: string[] = [];
      if (resA.kind === "err") errors.push(`Codex: ${resA.error}`);
      if (resB.kind === "err") errors.push(`シーン内: ${resB.error}`);

      if (errors.length === 2) {
        toast.error("整合性チェックに失敗しました", {
          description: errors.join(" / "),
        });
        return;
      }
      if (errors.length === 1) {
        const label = resA.kind === "err" ? "Codex整合性" : "シーン内矛盾";
        toast.error(`整合性チェック (${label}) に失敗しました`, {
          description: errors[0],
        });
      } else {
        const bothCache =
          resA.kind === "ok" &&
          resB.kind === "ok" &&
          resA.e.from_cache === true &&
          resB.e.from_cache === true;
        const totalCount =
          (resA.kind === "ok" ? resA.e.annotation_count : 0) +
          (resB.kind === "ok" ? resB.e.annotation_count : 0);

        if (bothCache) {
          toast.info("前回と同じ内容のためキャッシュから読み込みました", {
            description: "AI には送信していません",
          });
        } else if (totalCount === 0) {
          toast.success("矛盾は見つかりませんでした");
        }
        // totalCount ≥ 1 かつ片方以上 fresh: アノテーションが UI に出るので toast 不要
      }

      // 別モデル検出件数の info 通知
      const otherModelCount = countOpenByOtherModel(resp.annotations, model);
      if (otherModelCount.total > 0) {
        const sample = [...otherModelCount.byModel.entries()]
          .map(([m, n]) => `${m}: ${n}件`)
          .join(", ");
        toast.info(
          `${otherModelCount.total} 件は別モデルで検出された指摘です`,
          { description: sample },
        );
      }
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
        aria-label="このシーンの整合性チェック（Codex + シーン内）"
        title={
          analysisCapability.state === "disabled"
            ? analysisCapability.reason === "policy"
              ? "AIポリシーにより無効"
              : analysisCapability.reason === "no-model"
                ? "AIモデルが未選択です"
                : "AIが未設定です"
            : "このシーンの整合性チェック（Codex + シーン内）"
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
