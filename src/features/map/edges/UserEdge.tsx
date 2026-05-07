import { memo, useState, useRef, useEffect, useCallback } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";

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
  onSave,
}: {
  value: string | null | undefined;
  color: string;
  offsetY: number;
  labelX: number;
  labelY: number;
  onSave: (label: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
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
      ) : (
        <div style={{ width: 24, height: 16, cursor: "text" }} />
      )}
    </div>
  );
}

export const UserEdge = memo(function UserEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
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

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const strokeDasharray =
    edgeStyle === "dashed" ? "6 3" : edgeStyle === "dotted" ? "2 3" : undefined;

  const markerEnd =
    direction === "forward" || direction === "bidirectional"
      ? `url(#arrow-${id})`
      : undefined;
  const markerStart =
    direction === "bidirectional" ? `url(#arrow-start-${id})` : undefined;

  const hasForward = d.forwardLabel !== undefined;
  const hasBackward = d.backwardLabel !== undefined;
  // If only one label exists, center it; if both, offset each
  const forwardOffsetY = hasBackward ? -14 : 0;
  const backwardOffsetY = hasForward ? 14 : 0;

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
          onSave={(label) => d.onLabelSave?.("forwardLabel", label)}
        />
        {hasBackward && (
          <InlineLabel
            value={d.backwardLabel}
            color={color}
            offsetY={backwardOffsetY}
            labelX={labelX}
            labelY={labelY}
            onSave={(label) => d.onLabelSave?.("backwardLabel", label)}
          />
        )}
      </EdgeLabelRenderer>
    </>
  );
});
