import { useState, useCallback } from "react";
import { ScanText, Loader2, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAnnotationStore } from "./annotationStore";
import {
  buildConsistencyPayload,
  CONSISTENCY_PROMPT_VERSION,
} from "./consistencyPayloadBuilder";
import { runPostEffect } from "./api";
import { listAnnotationsForScene } from "./api";
import type { Editor } from "@tiptap/core";

interface Props {
  sceneId: string;
  editor: Editor | null;
  model?: string;
}

export function PostEffectToolbar({
  sceneId,
  editor,
  model = "gpt-4o-mini",
}: Props) {
  const [running, setRunning] = useState(false);
  const { showAnnotations, toggleShowAnnotations, setAnnotations } =
    useAnnotationStore();

  const run = useCallback(async () => {
    if (!editor || running) return;
    const projectId = useTreeStore.getState().projectId;
    setRunning(true);
    try {
      const payload = await buildConsistencyPayload(projectId, sceneId, model);
      const { cleanup } = await runPostEffect(
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
          onDone: async () => {
            cleanup();
            const resp = await listAnnotationsForScene({ projectId, sceneId });
            setAnnotations(sceneId, resp.annotations);
            setRunning(false);
          },
          onError: (e) => {
            cleanup();
            console.error("post-effect error", e.error);
            setRunning(false);
          },
        },
      );
    } catch (e) {
      console.error("post-effect launch error", e);
      setRunning(false);
    }
  }, [editor, running, sceneId, model, setAnnotations]);

  return (
    <div className="flex items-center gap-1">
      <button
        aria-label="整合性チェック実行"
        title="整合性チェック実行"
        disabled={running}
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
        onClick={toggleShowAnnotations}
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
