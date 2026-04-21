import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface CodexNodeData {
  name: string;
  type: string;
  summary?: string;
  color?: string;
  [key: string]: unknown;
}

export const CodexNode = memo(function CodexNode({
  data,
  selected,
}: NodeProps) {
  const d = data as CodexNodeData;
  const borderColor = d.color ?? "#888";
  const summary = d.summary
    ? d.summary.slice(0, 40) + (d.summary.length > 40 ? "…" : "")
    : "";

  return (
    <div
      style={{
        width: 200,
        background: "var(--card)",
        border: `2px solid ${selected ? "#534AB7" : "var(--border)"}`,
        borderLeft: `4px solid ${borderColor}`,
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
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      <div
        style={{
          fontWeight: 600,
          color: "var(--card-foreground)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={d.name}
      >
        {d.name}
      </div>

      <div
        style={{
          color: "var(--muted-foreground)",
          fontSize: 11,
          marginBottom: summary ? 4 : 0,
        }}
      >
        {d.type}
      </div>

      {summary && (
        <div
          style={{
            color: "var(--card-foreground)",
            fontSize: 11,
          }}
        >
          {summary}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});
