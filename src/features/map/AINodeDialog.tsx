import { createPortal } from "react-dom";

interface AINodeDialogProps {
  boardId: string;
  contextLines: string[];
  spawnPosition: { x: number; y: number };
  onCreated: (node: unknown) => void;
  onCancel: () => void;
}

// Phase C placeholder — AIBranchDialog will replace this
export function AINodeDialog({ onCancel }: AINodeDialogProps) {
  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onCancel}
    >
      <div
        className="bg-popover border border-border rounded-lg shadow-xl p-6"
        style={{ minWidth: 320 }}
        onClick={(e) => e.stopPropagation()}
      >
        <p
          className="text-foreground"
          style={{ fontSize: 14, marginBottom: 16 }}
        >
          AI Branch は Phase C で実装予定です。
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="hover:bg-accent text-foreground"
            style={{
              padding: "4px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "1px solid var(--border)",
              cursor: "pointer",
              background: "transparent",
            }}
            onClick={onCancel}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
