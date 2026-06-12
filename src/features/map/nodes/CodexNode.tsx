import { Pencil } from "lucide-react";
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { parseTags } from "@/features/codex/components/EntryCard";
import { TagPill } from "@/features/codex/components/TagPill";
import { EntryIcon } from "@/features/codex/components/EntryIcon";
import { FloatingHandle } from "./FloatingHandle";
import { NodeBranchToolbar } from "./NodeBranchToolbar";

export interface CodexNodeData {
  name: string;
  type: string;
  summary?: string;
  color?: string;
  tagsCache?: string | null;
  icon?: string | null;
  colorBy?: "none" | "status";
  onOpen?: () => void;
  onBranchFrom?: (dir: "left" | "right") => void;
  [key: string]: unknown;
}

export const CodexNode = memo(function CodexNode({
  data,
  selected,
  isConnectable,
}: NodeProps) {
  const d = data as CodexNodeData;
  // colorBy=none disables the intrinsic type accent stripe for visual calm.
  const borderColor =
    d.colorBy === "none" ? "transparent" : (d.color ?? "#888");
  const summary = d.summary
    ? d.summary.slice(0, 40) + (d.summary.length > 40 ? "…" : "")
    : "";
  const tags = parseTags(d.tagsCache);

  return (
    <div
      onDoubleClick={(e) => {
        e.stopPropagation();
        d.onOpen?.();
      }}
      style={{
        position: "relative",
        width: 200,
        background: "var(--card)",
        border: `2px solid ${selected ? "#534AB7" : "var(--border)"}`,
        borderLeft:
          d.colorBy === "none"
            ? `2px solid ${selected ? "#534AB7" : "var(--border)"}`
            : `4px solid ${borderColor}`,
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
      <FloatingHandle isConnectable={isConnectable} />
      <NodeBranchToolbar onBranchFrom={d.onBranchFrom} />
      <button
        type="button"
        className="map-edit-indicator"
        title="Codex で開く"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          d.onOpen?.();
        }}
      >
        <Pencil size={11} aria-hidden />
      </button>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
        }}
      >
        <EntryIcon icon={d.icon} entryType={d.type} size={24} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontWeight: 600,
            color: "var(--card-foreground)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={d.name}
        >
          {d.name}
        </span>
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

      {tags.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 3,
            marginTop: 4,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {tags.slice(0, 3).map((tag) => (
            <TagPill
              key={tag.name}
              name={tag.name}
              color={tag.color}
              size="sm"
            />
          ))}
          {tags.length > 3 && (
            <span
              style={{
                fontSize: 10,
                color: "var(--muted-foreground)",
                padding: "0 4px",
              }}
            >
              +{tags.length - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
