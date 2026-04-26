import { memo, useState, useRef, useEffect, useCallback } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";

export interface UserEdgeData {
  label?: string | null;
  style?: "solid" | "dashed" | "dotted";
  color?: string;
  direction?: "none" | "forward" | "bidirectional";
  onLabelSave?: (label: string | null) => void;
  [key: string]: unknown;
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
  const color = d.color ?? "#555";
  const edgeStyle = d.style ?? "solid";
  const direction = d.direction ?? "none";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const onLabelSaveRef = useRef(d.onLabelSave);
  onLabelSaveRef.current = d.onLabelSave;

  const startEdit = useCallback(() => {
    setDraft(d.label ?? "");
    setEditing(true);
  }, [d.label]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    onLabelSaveRef.current?.(trimmed === "" ? null : trimmed);
  }, [draft]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

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

  return (
    <>
      {/* Arrow marker defs */}
      <defs>
        <marker
          id={`arrow-${id}`}
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L0,6 L8,3 z" fill={color} />
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
            <path d="M0,0 L0,6 L8,3 z" fill={color} />
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
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
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
                // Stop all keys except Tab to prevent canvas shortcuts (e.g. 'e' for connect mode)
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
          ) : d.label ? (
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
              {d.label}
            </div>
          ) : (
            // Invisible hit-area so edge-midpoint double-click always works
            <div style={{ width: 24, height: 16, cursor: "text" }} />
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
