import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface AIBranchNodeData {
  prompt: string;
  sessionId?: string | null;
  onOpenChat?: () => void;
  [key: string]: unknown;
}

export const AIBranchNode = memo(function AIBranchNode({
  data,
  selected,
}: NodeProps) {
  const d = data as AIBranchNodeData;
  const promptPreview = d.prompt.slice(0, 60);
  const hasSession = !!d.sessionId;

  return (
    <div style={{ position: "relative" }}>
      <Handle type="target" position={Position.Left} className="map-handle" />
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
          background: "#FEF9C3",
          border: `2px solid ${selected ? "#534AB7" : "#F59E0B"}`,
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
            borderBottom: "1px solid #FDE68A",
            paddingBottom: 4,
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 13 }}>✨</span>
          <span
            style={{
              fontWeight: 600,
              fontSize: 11,
              color: "#92400E",
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
              style={{ fontSize: 10, color: "#D97706" }}
            >
              ⚠
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "#78350F",
            opacity: 0.7,
          }}
        >
          AI Branch
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="map-handle" />
    </div>
  );
});
