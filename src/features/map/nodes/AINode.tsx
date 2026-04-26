import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface AINodeData {
  prompt: string;
  response?: string | null;
  sessionId?: string | null;
  onOpenChat?: () => void;
  [key: string]: unknown;
}

export const AINode = memo(function AINode({ data, selected }: NodeProps) {
  const d = data as AINodeData;
  const promptPreview = d.prompt.slice(0, 60);
  const responsePreview = (d.response ?? "").slice(0, 80);
  const hasSession = !!d.sessionId;

  return (
    <div style={{ position: "relative" }}>
      <Handle type="target" position={Position.Left} className="map-handle" />
      <span className="map-edit-indicator" aria-hidden>
        ✎
      </span>
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
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            marginBottom: 4,
            borderBottom: "1px solid #FDE68A",
            paddingBottom: 4,
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
        {/* Response preview */}
        {responsePreview && (
          <div
            style={{
              color: "#78350F",
              fontSize: 11,
              lineHeight: 1.5,
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {responsePreview}
            {(d.response ?? "").length > 80 ? "…" : ""}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="map-handle" />
    </div>
  );
});
