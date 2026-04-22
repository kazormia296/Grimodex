import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface NoteNodeData {
  title: string;
  content?: string | null;
  onOpen?: () => void;
  [key: string]: unknown;
}

export const NoteNode = memo(function NoteNode({ data, selected }: NodeProps) {
  const d = data as NoteNodeData;
  const preview = (d.content ?? "").trim().slice(0, 40);

  return (
    <div>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div
        onDoubleClick={(e) => {
          e.stopPropagation();
          d.onOpen?.();
        }}
        style={{
          width: 180,
          minHeight: 72,
          background: "#FEFCE8",
          border: `2px solid ${selected ? "#534AB7" : "#E5D87A"}`,
          borderRadius: 6,
          padding: "6px 10px",
          boxShadow: selected
            ? "0 0 0 2px rgba(83,74,183,0.3)"
            : "0 1px 3px rgba(0,0,0,0.12)",
          cursor: "default",
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
            marginBottom: 3,
          }}
        >
          <span style={{ fontSize: 13 }}>📝</span>
          <span
            style={{
              fontWeight: 600,
              color: "#78716C",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
            title={d.title}
          >
            {d.title}
          </span>
        </div>
        {preview && (
          <div
            style={{
              color: "#92918C",
              fontSize: 11,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={d.content ?? ""}
          >
            {preview}
            {(d.content ?? "").trim().length > 40 ? "…" : ""}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});
