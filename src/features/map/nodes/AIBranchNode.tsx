import { memo, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { FloatingHandle } from "./FloatingHandle";
import { NodeBranchToolbar } from "./NodeBranchToolbar";

export interface AIBranchNodeData {
  prompt: string;
  sessionId?: string | null;
  derivedStickyCount?: number;
  onOpenChat?: () => void;
  onDelete?: () => void;
  onBranchFrom?: (dir: "left" | "right") => void;
  [key: string]: unknown;
}

export const AIBranchNode = memo(function AIBranchNode({
  data,
  selected,
  isConnectable,
}: NodeProps) {
  const d = data as AIBranchNodeData;
  const promptPreview = d.prompt.slice(0, 60);
  const hasSession = !!d.sessionId;
  const count = d.derivedStickyCount ?? 0;
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <FloatingHandle isConnectable={isConnectable} />
      <NodeBranchToolbar onBranchFrom={d.onBranchFrom} />

      {/* × delete badge */}
      {(hovered || selected) && d.onDelete && (
        <button
          type="button"
          title="AI Branch を削除"
          onClick={(e) => {
            e.stopPropagation();
            d.onDelete?.();
          }}
          style={{
            position: "absolute",
            top: -8,
            right: -8,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#EF4444",
            color: "#fff",
            border: "none",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 700,
            lineHeight: "18px",
            textAlign: "center",
            zIndex: 10,
            padding: 0,
          }}
        >
          ×
        </button>
      )}

      <div
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (hasSession) d.onOpenChat?.();
        }}
        title={
          hasSession
            ? "ダブルクリックでChatパネルに表示"
            : "Chatセッションが削除されました"
        }
        style={{
          width: 220,
          background: "#DBEAFE",
          border: `2px solid ${selected ? "#534AB7" : "#2563EB"}`,
          borderRadius: 6,
          padding: "6px 10px",
          boxShadow: selected
            ? "0 0 0 2px rgba(83,74,183,0.3)"
            : "0 1px 3px rgba(0,0,0,0.12)",
          cursor: hasSession ? "pointer" : "default",
          userSelect: "none",
          fontSize: 12,
          lineHeight: 1.4,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            borderBottom: "1px solid #BFDBFE",
            paddingBottom: 4,
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 13 }}>✨</span>
          <span
            style={{
              fontWeight: 600,
              fontSize: 11,
              color: "#1E40AF",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={d.prompt}
          >
            {promptPreview}
            {d.prompt.length > 60 ? "…" : ""}
          </span>
          {!hasSession && (
            <span
              title="Chatセッションが削除されました"
              style={{ fontSize: 10, color: "#3B82F6" }}
            >
              ⚠
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "#1E3A8A",
            opacity: 0.7,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span>AI Branch</span>
          {count > 0 && (
            <span
              style={{
                background: "#BFDBFE",
                borderRadius: 8,
                padding: "1px 6px",
                fontSize: 10,
                color: "#1E40AF",
              }}
            >
              {count} 枚
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
