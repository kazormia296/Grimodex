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
    <div style={{ position: "relative" }}>
      <Handle type="target" position={Position.Left} className="map-handle" />
      <span className="map-edit-indicator" aria-hidden>
        ✎
      </span>
      <div
        onDoubleClick={(e) => {
          e.stopPropagation();
          d.onOpen?.();
        }}
        style={{
          width: 180,
          minHeight: 72,
          background: "var(--note-bg)",
          border: `2px solid ${selected ? "#534AB7" : "var(--note-border)"}`,
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
              color: "var(--muted-foreground)",
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
              color: "var(--muted-foreground)",
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
      <Handle type="source" position={Position.Right} className="map-handle" />
    </div>
  );
});
