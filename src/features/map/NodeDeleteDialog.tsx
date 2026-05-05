import { createPortal } from "react-dom";

interface NodeDeleteDialogProps {
  count: number;
  onDelete: () => void;
  onCancel: () => void;
}

export function NodeDeleteDialog({
  count,
  onDelete,
  onCancel,
}: NodeDeleteDialogProps) {
  const label = count === 1 ? "1件" : `${count}件`;

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
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="bg-popover border border-border rounded-lg shadow-xl p-6"
        style={{ minWidth: 360, maxWidth: 440 }}
      >
        <h3
          style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}
          className="text-foreground"
        >
          {label}のノードを削除しますか？
        </h3>
        <p
          style={{ fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}
          className="text-muted-foreground"
        >
          シーン・Codex
          などのエンティティは元のデータも完全に削除されます。この操作は取り消せません。
          <br />
          ボードから外すだけの場合は右クリック
          →「このボードから削除」を使ってください。
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
            キャンセル
          </button>
          <button
            type="button"
            style={{
              padding: "4px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "none",
              cursor: "pointer",
              background: "var(--destructive)",
              color: "var(--destructive-foreground)",
            }}
            onClick={onDelete}
          >
            削除
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
