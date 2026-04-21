import { memo } from "react";
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

      {d.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: "var(--background)",
              border: `1px solid ${color}`,
              borderRadius: 4,
              padding: "1px 6px",
              fontSize: 11,
              color: "var(--foreground)",
              pointerEvents: "all",
              cursor: "default",
              userSelect: "none",
            }}
            className="nodrag nopan"
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
