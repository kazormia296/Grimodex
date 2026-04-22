import { createPortal } from "react-dom";
import type { AutoArrangeType } from "./layouts/autoArrange";

const LABELS: Record<AutoArrangeType, string> = {
  "reading-order": "読み順でグリッド配置",
  "story-time": "物語時間順でグリッド配置",
};

interface AutoArrangeDialogProps {
  type: AutoArrangeType;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AutoArrangeDialog({
  type,
  onConfirm,
  onCancel,
}: AutoArrangeDialogProps) {
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
          ノードを並び替えますか？
        </h3>
        <p
          style={{ fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}
          className="text-muted-foreground"
        >
          「{LABELS[type]}」を実行します。
          <br />
          ピン留め済みのノードは移動しません。それ以外のシーンノードがグリッドに再配置されます。
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
              background: "#534AB7",
              color: "#fff",
            }}
            onClick={onConfirm}
          >
            実行
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
