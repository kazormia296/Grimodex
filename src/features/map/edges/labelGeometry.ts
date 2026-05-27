import { Position } from "@xyflow/react";

export type Pt = { x: number; y: number };

/**
 * Mirrors React Flow's internal `calculateControlOffset` so we can reconstruct
 * the bezier control points that `getBezierPath` consumes but does not expose.
 * Distance >= 0 collapses to half the distance; otherwise the curvature term
 * pulls the control point back to give a U-shape on opposing handles.
 */
function calculateControlOffset(distance: number, curvature: number): number {
  if (distance >= 0) return 0.5 * distance;
  return curvature * 25 * Math.sqrt(-distance);
}

function getControlPoint(
  pos: Position,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature: number,
): Pt {
  switch (pos) {
    case Position.Left:
      return { x: x1 - calculateControlOffset(x1 - x2, curvature), y: y1 };
    case Position.Right:
      return { x: x1 + calculateControlOffset(x2 - x1, curvature), y: y1 };
    case Position.Top:
      return { x: x1, y: y1 - calculateControlOffset(y1 - y2, curvature) };
    case Position.Bottom:
      return { x: x1, y: y1 + calculateControlOffset(y2 - y1, curvature) };
  }
}

/** Reconstruct the cubic bezier control points React Flow uses internally. */
export function getBezierControlPoints(
  sx: number,
  sy: number,
  sourcePos: Position,
  tx: number,
  ty: number,
  targetPos: Position,
  curvature = 0.25,
): { p0: Pt; p1: Pt; p2: Pt; p3: Pt } {
  return {
    p0: { x: sx, y: sy },
    p1: getControlPoint(sourcePos, sx, sy, tx, ty, curvature),
    p2: getControlPoint(targetPos, tx, ty, sx, sy, curvature),
    p3: { x: tx, y: ty },
  };
}

export function bezierAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x:
      u * u * u * p0.x +
      3 * u * u * t * p1.x +
      3 * u * t * t * p2.x +
      t * t * t * p3.x,
    y:
      u * u * u * p0.y +
      3 * u * u * t * p1.y +
      3 * u * t * t * p2.y +
      t * t * t * p3.y,
  };
}

export function bezierTangent(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x:
      3 * u * u * (p1.x - p0.x) +
      6 * u * t * (p2.x - p1.x) +
      3 * t * t * (p3.x - p2.x),
    y:
      3 * u * u * (p1.y - p0.y) +
      6 * u * t * (p2.y - p1.y) +
      3 * t * t * (p3.y - p2.y),
  };
}

/**
 * Half-extent of an axis-aligned rectangle (W,H) measured from its center
 * along the unit direction (nx, ny). This is the AABB support function:
 * `halfExtent = W/2*|nx| + H/2*|ny|`. Horizontal directions yield W/2,
 * vertical ones yield H/2, and oblique directions interpolate continuously.
 */
export function halfExtent(
  nx: number,
  ny: number,
  w: number,
  h: number,
): number {
  return (Math.abs(nx) * w + Math.abs(ny) * h) / 2;
}

/**
 * Place a label so that its AABB just clears the curve at t=0.5.
 *
 * Direction is the bezier-tangent normal at the midpoint, which tracks the
 * curve's local geometry. The sign of that normal is anchored to a stable
 * reference — the caller-supplied `outwardHint` — so the label does not flip
 * to the opposite side when the curve straightens through a near-linear
 * configuration (the regression that pure-curvature-sign approaches hit).
 *
 * Pass `outwardHint` as the direction the label should be pushed in, expressed
 * in any units; only its sign relative to the tangent normal is used.
 */
export function getLabelPos(
  p0: Pt,
  p1: Pt,
  p2: Pt,
  p3: Pt,
  labelW: number,
  labelH: number,
  outwardHint: Pt,
  padding = 6,
): Pt {
  const B = bezierAt(p0, p1, p2, p3, 0.5);
  const Bp = bezierTangent(p0, p1, p2, p3, 0.5);
  const len = Math.hypot(Bp.x, Bp.y) || 1;
  const tx = Bp.x / len;
  const ty = Bp.y / len;
  // One arbitrary tangent normal; sign is reconciled against outwardHint below
  // so the visible side stays continuous as the curve evolves.
  const nx = -ty;
  const ny = tx;
  const sign = nx * outwardHint.x + ny * outwardHint.y >= 0 ? 1 : -1;
  const half = halfExtent(nx, ny, labelW, labelH);
  const d = (half + padding) * sign;
  return { x: B.x + d * nx, y: B.y + d * ny };
}
