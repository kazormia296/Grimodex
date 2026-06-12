import { Scissors } from "lucide-react";
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { FloatingHandle } from "./FloatingHandle";
import { NodeBranchToolbar } from "./NodeBranchToolbar";

export interface SnippetNodeData {
  title: string | null;
  content: string;
  onBranchFrom?: (dir: "left" | "right") => void;
  [key: string]: unknown;
}

export const SnippetNode = memo(function SnippetNode({
  data,
  selected,
  isConnectable,
}: NodeProps) {
  const d = data as SnippetNodeData;
  const label = d.title?.trim() || d.content.trim().slice(0, 40);

  return (
    <div style={{ position: "relative" }}>
      <FloatingHandle isConnectable={isConnectable} />
      <NodeBranchToolbar onBranchFrom={d.onBranchFrom} />
      <div
        style={{
          width: 200,
          height: 40,
          background: "var(--muted)",
          border: `1.5px solid ${selected ? "#534AB7" : "var(--border)"}`,
          borderRadius: 4,
          padding: "0 10px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          boxShadow: selected
            ? "0 0 0 2px rgba(83,74,183,0.3)"
            : "0 1px 2px rgba(0,0,0,0.08)",
          cursor: "default",
          userSelect: "none",
          overflow: "hidden",
        }}
      >
        <Scissors size={13} aria-hidden style={{ flexShrink: 0 }} />
        <span
          style={{
            fontSize: 11,
            color: "var(--foreground)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={d.title ?? d.content}
        >
          {label}
          {!d.title && d.content.trim().length > 40 ? "…" : ""}
        </span>
      </div>
    </div>
  );
});
