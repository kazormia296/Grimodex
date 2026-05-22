import { memo, useState, useRef, useEffect, useCallback } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";
import { getFloatingEdgeParams } from "./floatingEdge";

export interface UserEdgeData {
  forwardLabel?: string | null;
  backwardLabel?: string | null;
  style?: "solid" | "dashed" | "dotted";
  color?: string;
  direction?: "none" | "forward" | "bidirectional";
  onLabelSave?: (
    field: "forwardLabel" | "backwardLabel",
    label: string | null,
  ) => void;
  [key: string]: unknown;
}

function InlineLabel({
  value,
  color,
  offsetY,
  labelX,
  labelY,
  selected,
  onSave,
}: {
  value: string | null | undefined;
  color: string;
  offsetY: number;
  labelX: number;
  labelY: number;
  selected: boolean;
  onSave: (label: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const startEdit = useCallback(() => {
    setDraft(value ?? "");
    setEditing(true);
  }, [value]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    onSaveRef.current(trimmed === "" ? null : trimmed);
  }, [draft]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  return (
    <div
      style={{
        position: "absolute",
        transform: `translate(-50%, -50%) translate(${labelX}px,${labelY + offsetY}px)`,
        pointerEvents: "all",
      }}
      className="nodrag nopan"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        startEdit();
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditing(false);
            if (e.key !== "Tab") e.stopPropagation();
          }}
          style={{
            fontSize: 11,
            padding: "1px 6px",
            borderRadius: 4,
            border: `1px solid ${color}`,
            background: "var(--background)",
            color: "var(--foreground)",
            outline: "none",
            minWidth: 60,
            maxWidth: 160,
          }}
        />
      ) : value ? (
        <div
          style={{
            background: "var(--background)",
            border: `1px solid ${color}`,
            borderRadius: 4,
            padding: "1px 6px",
            fontSize: 11,
            color: "var(--foreground)",
            cursor: "default",
            userSelect: "none",
          }}
        >
          {value}
        </div>
      ) : selected || hovered ? (
        <button
          type="button"
          className="nodrag nopan"
          onClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
          style={{
            background: "var(--background)",
            border: `1px dashed ${color}`,
            borderRadius: 4,
            padding: "1px 6px",
            fontSize: 11,
            color: "var(--muted-foreground)",
            cursor: "pointer",
            whiteSpace: "nowrap",
            opacity: 0.9,
          }}
        >
          ＋ラベル
        </button>
      ) : (
        <div style={{ width: 24, height: 16, cursor: "text" }} />
      )}
    </div>
  );
}

export const UserEdge = memo(function UserEdge({
  id,
  source,
  target,
  data,
  selected,
}: EdgeProps) {
  const d = data as UserEdgeData;
  // Treat legacy "#000000" default and "currentColor" sentinel as theme-aware:
  // resolve to var(--foreground) so edges adapt to dark/light theme.
  const rawColor = d.color ?? "currentColor";
  const isThemed = rawColor === "currentColor" || rawColor === "#000000";
  const color = isThemed ? "var(--foreground)" : rawColor;
  const edgeStyle = d.style ?? "solid";
  const direction = d.direction ?? "none";

  // Floating edge: anchor at the node-rectangle border closest to the other
  // node, instead of at a fixed handle position. Both nodes use a single
  // invisible handle that covers their entire bounds, so the visual
  // attachment point is computed from node geometry every render.
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  const params =
    sourceNode && targetNode
      ? getFloatingEdgeParams(sourceNode, targetNode)
      : null;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: params?.sx ?? 0,
    sourceY: params?.sy ?? 0,
    sourcePosition: params?.sourcePos,
    targetX: params?.tx ?? 0,
    targetY: params?.ty ?? 0,
    targetPosition: params?.targetPos,
  });

  if (!params) return null;

  const strokeDasharray =
    edgeStyle === "dashed" ? "6 3" : edgeStyle === "dotted" ? "2 3" : undefined;

  const markerEnd =
    direction === "forward" || direction === "bidirectional"
      ? `url(#arrow-${id})`
      : undefined;
  const markerStart =
    direction === "bidirectional" ? `url(#arrow-start-${id})` : undefined;

  const forwardHasText =
    typeof d.forwardLabel === "string" && d.forwardLabel.length > 0;
  const backwardHasText =
    typeof d.backwardLabel === "string" && d.backwardLabel.length > 0;
  // The backward-label slot stays hidden until the forward label has a
  // value, so a labelless edge surfaces a single "＋ラベル" affordance
  // instead of two stacked empty placeholders.
  const showBackward = forwardHasText || backwardHasText;
  const forwardOffsetY = showBackward ? -14 : 0;
  const backwardOffsetY = 14;

  return (
    <>
      <defs>
        <marker
          id={`arrow-${id}`}
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L0,6 L8,3 z" style={{ fill: color }} />
        </marker>
        {direction === "bidirectional" && (
          <marker
            id={`arrow-start-${id}`}
            markerWidth="8"
            markerHeight="8"
            refX="2"
            refY="3"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L0,6 L8,3 z" style={{ fill: color }} />
          </marker>
        )}
      </defs>

      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: selected ? 3 : 2,
          strokeDasharray,
          opacity: selected ? 1 : 0.75,
        }}
        markerEnd={markerEnd}
        markerStart={markerStart}
      />

      <EdgeLabelRenderer>
        <InlineLabel
          value={d.forwardLabel}
          color={color}
          offsetY={forwardOffsetY}
          labelX={labelX}
          labelY={labelY}
          selected={!!selected}
          onSave={(label) => d.onLabelSave?.("forwardLabel", label)}
        />
        {showBackward && (
          <InlineLabel
            value={d.backwardLabel}
            color={color}
            offsetY={backwardOffsetY}
            labelX={labelX}
            labelY={labelY}
            selected={!!selected}
            onSave={(label) => d.onLabelSave?.("backwardLabel", label)}
          />
        )}
      </EdgeLabelRenderer>
    </>
  );
});
