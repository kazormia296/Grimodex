import { useCallback } from "react";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSceneStore } from "@/features/scene/store";
import { buildAgentTraceRecord, serializeRecord } from "./agentTrace";

function downloadJson(json: string, fileName: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportAgentTraceButton() {
  const editor = useEditorStore((s) => s.editor);
  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const scenes = useSceneStore((s) => s.scenes);

  const handleExport = useCallback(async () => {
    if (!editor || !activeSceneId) return;

    const scene = scenes.find((s) => s.id === activeSceneId);
    const title = scene?.title ?? "untitled";

    const record = await buildAgentTraceRecord(
      editor.state.doc,
      activeSceneId,
      title,
    );

    const json = serializeRecord(record);
    downloadJson(json, `${title}.agent-trace.json`);
  }, [editor, activeSceneId, scenes]);

  return (
    <button
      type="button"
      data-testid="export-agent-trace"
      onClick={handleExport}
      disabled={!editor || !activeSceneId}
      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      帰属エクスポート
    </button>
  );
}
