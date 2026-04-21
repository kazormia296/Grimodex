import { useCallback } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";

export function MapPalette() {
  const createScene = useTreeStore((s) => s.createScene);
  const createCodexEntry = useCodexStore((s) => s.create);

  const handleAddScene = useCallback(async () => {
    await createScene();
  }, [createScene]);

  const handleAddCodex = useCallback(async () => {
    await createCodexEntry({
      name: "新しいエントリ",
      type: "character",
      summary: "",
    });
  }, [createCodexEntry]);

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 8,
        zIndex: 10,
        background: "var(--sidebar-background)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "6px 12px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      }}
    >
      <button
        onClick={handleAddScene}
        style={{
          padding: "4px 12px",
          fontSize: 13,
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--secondary)",
          color: "var(--secondary-foreground)",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        + Scene
      </button>
      <button
        onClick={handleAddCodex}
        style={{
          padding: "4px 12px",
          fontSize: 13,
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--secondary)",
          color: "var(--secondary-foreground)",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        + Codex
      </button>
    </div>
  );
}
