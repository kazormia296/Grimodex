import { memo, useState, useRef, useEffect, useCallback } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";
import { getFloatingEdgeParams } from "./floatingEdge";
import { pendingEdgeLabelEdits } from "../mapApi";

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
  /**
   * Set by useMapEdges from pendingEdgeLabelEdits. When InlineLabel sees its
   * own field name here, it auto-enters edit mode (used by EdgeContextMenu
   * 「ラベル編集」).
   */
  startEditField?: "forwardLabel" | "backwardLabel" | null;
  [key: string]: unknown;
}

function InlineLabel({
  value,
  color,
  offsetY,
  labelX,
  labelY,
  selected,
  field,
  startEditField,
  onSave,
  onAutoEditConsumed,
}: {
  value: string | null | undefined;
  color: string;
  offsetY: number;
  labelX: number;
  labelY: number;
  selected: boolean;
  field: "forwardLabel" | "backwardLabel";
  startEditField?: "forwardLabel" | "backwardLabel" | null;
  onSave: (label: string | null) => void;
  onAutoEditConsumed: () => void;
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

  // Auto-enter edit mode when EdgeContextMenu「ラベル編集」requested it.
  useEffect(() => {
    if (startEditField === field) {
      setDraft(value ?? "");
      setEditing(true);
      onAutoEditConsumed();
    }
    // value/onAutoEditConsumed intentionally omitted: this should fire only
    // when the signal changes, not when value re-arrives on save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEditField, field]);

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
        // Invisible hover hit-area. Made generous (80×32) so the parent
        // wrapper's onMouseEnter reliably fires when the user approaches the
        // edge midpoint — otherwise the「＋ラベル」placeholder becomes
        // practically un-discoverable on a thin (2-3px) edge line.
        <div style={{ width: 80, height: 32, cursor: "text" }} />
      )}
    </div>
  );
}

// Visual separation between the two parallel strands when both labels exist.
const PARALLEL_OFFSET = 6;

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

  // Once an InlineLabel consumes the auto-edit signal, clear the module-level
  // map so a subsequent re-render does not re-enter edit mode involuntarily.
  const onAutoEditConsumed = useCallback(() => {
    if (id.startsWith("user:")) {
      pendingEdgeLabelEdits.delete(id.slice("user:".length));
    }
  }, [id]);

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

  const forwardHasText =
    typeof d.forwardLabel === "string" && d.forwardLabel.length > 0;
  const backwardHasText =
    typeof d.backwardLabel === "string" && d.backwardLabel.length > 0;
  // The backward「＋ラベル」affordance only appears once the forward label
  // exists, so a labelless edge surfaces a single "＋ラベル" entry point.
  // Parallel rendering kicks in only after the backward label actually has
  // text — otherwise the backward affordance rides the single line with the
  // legacy Y-offset stacking.
  const showBackwardSlot = forwardHasText || backwardHasText;
  const parallel = backwardHasText;

  const sx = params?.sx ?? 0;
  const sy = params?.sy ?? 0;
  const tx = params?.tx ?? 0;
  const ty = params?.ty ?? 0;
  const dxv = tx - sx;
  const dyv = ty - sy;
  const len = Math.hypot(dxv, dyv);
  // Unit perpendicular to source→target. Zero-length fallback keeps degenerate
  // self-loops from producing NaN coordinates.
  const nx = len > 0 ? -dyv / len : 0;
  const ny = len > 0 ? dxv / len : 0;

  // Single-strand layout: bezier midpoint is the natural anchor for the
  // forward label (and the backward「＋ラベル」affordance) so the visible
  // label tracks the curve as the nodes move.
  const [singlePath, singleLabelX, singleLabelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: params?.sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: params?.targetPos,
  });

  // Parallel-strand layout: shift the endpoints perpendicular to the chord so
  // forward and backward labels each ride their own visible line.
  const offX = nx * PARALLEL_OFFSET;
  const offY = ny * PARALLEL_OFFSET;
  const [forwardPath, forwardLabelX, forwardLabelY] = getBezierPath({
    sourceX: sx + offX,
    sourceY: sy + offY,
    sourcePosition: params?.sourcePos,
    targetX: tx + offX,
    targetY: ty + offY,
    targetPosition: params?.targetPos,
  });
  const [backwardPath, backwardLabelX, backwardLabelY] = getBezierPath({
    sourceX: tx - offX,
    sourceY: ty - offY,
    sourcePosition: params?.targetPos,
    targetX: sx - offX,
    targetY: sy - offY,
    targetPosition: params?.sourcePos,
  });

  if (!params) return null;

  const strokeDasharray =
    edgeStyle === "dashed" ? "6 3" : edgeStyle === "dotted" ? "2 3" : undefined;

  const arrowEnd = `url(#arrow-${id})`;
  const arrowStart = `url(#arrow-start-${id})`;

  const baseStyle = {
    stroke: color,
    strokeWidth: selected ? 3 : 2,
    strokeDasharray,
    opacity: selected ? 1 : 0.75,
  };

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
        {direction === "bidirectional" && !parallel && (
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

      {parallel ? (
        <>
          <BaseEdge
            id={id}
            path={forwardPath}
            style={baseStyle}
            markerEnd={
              direction === "forward" || direction === "bidirectional"
                ? arrowEnd
                : undefined
            }
          />
          <BaseEdge
            id={`${id}-backward`}
            path={backwardPath}
            style={baseStyle}
            markerEnd={direction === "bidirectional" ? arrowEnd : undefined}
          />
        </>
      ) : (
        <BaseEdge
          id={id}
          path={singlePath}
          style={baseStyle}
          markerEnd={
            direction === "forward" || direction === "bidirectional"
              ? arrowEnd
              : undefined
          }
          markerStart={direction === "bidirectional" ? arrowStart : undefined}
        />
      )}

      <EdgeLabelRenderer>
        <InlineLabel
          value={d.forwardLabel}
          color={color}
          offsetY={parallel ? 0 : showBackwardSlot ? -14 : 0}
          labelX={parallel ? forwardLabelX : singleLabelX}
          labelY={parallel ? forwardLabelY : singleLabelY}
          selected={!!selected}
          field="forwardLabel"
          startEditField={d.startEditField}
          onSave={(label) => d.onLabelSave?.("forwardLabel", label)}
          onAutoEditConsumed={onAutoEditConsumed}
        />
        {showBackwardSlot && (
          <InlineLabel
            value={d.backwardLabel}
            color={color}
            offsetY={parallel ? 0 : 14}
            labelX={parallel ? backwardLabelX : singleLabelX}
            labelY={parallel ? backwardLabelY : singleLabelY}
            selected={!!selected}
            field="backwardLabel"
            startEditField={d.startEditField}
            onSave={(label) => d.onLabelSave?.("backwardLabel", label)}
            onAutoEditConsumed={onAutoEditConsumed}
          />
        )}
      </EdgeLabelRenderer>
    </>
  );
});
