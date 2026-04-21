import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface SceneNodeData {
  title: string;
  chapterLabel?: string;
  status?: string;
  wordCount?: number;
  [key: string]: unknown;
}

const STATUS_COLORS: Record<string, string> = {
  outline: "#888780",
  draft: "#EF9F27",
  complete: "#1D9E75",
  revision: "#7F77DD",
  final: "#22a06b",
};

export const SceneNode = memo(function SceneNode({
  data,
  selected,
}: NodeProps) {
  const d = data as SceneNodeData;
  const statusColor =
    STATUS_COLORS[d.status ?? "outline"] ?? STATUS_COLORS.outline;

  return (
    <div
      style={{
        width: 180,
        background: "var(--color-surface, #fff)",
        border: `2px solid ${selected ? "var(--color-accent, #534AB7)" : statusColor}`,
        borderRadius: 6,
        padding: "6px 10px",
        boxShadow: selected
          ? "0 0 0 2px var(--color-accent-muted, rgba(83,74,183,0.3))"
          : "0 1px 3px rgba(0,0,0,0.12)",
        cursor: "default",
        userSelect: "none",
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 2,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: statusColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontWeight: 600,
            color: "var(--color-text-muted, #888)",
            fontSize: 11,
          }}
        >
          {d.chapterLabel ?? ""}
        </span>
      </div>

      <div
        style={{
          fontWeight: 500,
          color: "var(--color-text, #111)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={d.title}
      >
        {d.title}
      </div>

      {d.wordCount != null && (
        <div
          style={{
            marginTop: 4,
            color: "var(--color-text-muted, #888)",
            fontSize: 11,
          }}
        >
          {d.wordCount.toLocaleString()} chars
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});
