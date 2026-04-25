import { createPortal } from "react-dom";

interface NodeDeleteDialogProps {
  count: number;
  onHide: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

export function NodeDeleteDialog({
  count,
  onHide,
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
      onClick={onCancel}
    >
      <div
        className="bg-popover border border-border rounded-lg shadow-xl p-6"
        style={{ minWidth: 360, maxWidth: 440 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}
          className="text-foreground"
        >
          {label}のノードをどうしますか？
        </h3>
        <p
          style={{ fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}
          className="text-muted-foreground"
        >
          「Mapから隠す」はこのボードでのみ非表示にします。エンティティ（シーン・Codex等）は残ります。
          <br />
          「エンティティごと削除」は元のデータも完全に削除します。この操作は取り消せません。
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
            className="hover:bg-accent text-foreground"
            style={{
              padding: "4px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "1px solid var(--border)",
              cursor: "pointer",
              background: "transparent",
            }}
            onClick={onHide}
          >
            Mapから隠す
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
            エンティティごと削除
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
