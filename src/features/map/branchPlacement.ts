// Compute a branch Sticky spawn position that avoids overlapping existing
// nodes. Called from MapCanvas when the user invokes "ここから分岐" (context
// menu) or the left/right + button on a selected node.
//
// Strategy: at each radius (starting at BRANCH_BASE_OFFSET, growing by
// BRANCH_RADIUS_STEP), sweep the half-circle on the output side from
// closest-to-horizontal outward (0°, ±15°, ±30°, …, ±90°). The first
// candidate that doesn't collide with an existing node + buffer wins.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const BRANCH_BASE_OFFSET = 280;
export const BRANCH_RADIUS_STEP = 60;
const MAX_RADIUS_STEPS = 12;
const ANGLE_DEGREES = [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75, 90, -90];
const OVERLAP_BUFFER = 16;

function rectsOverlap(a: Rect, b: Rect, buffer: number): boolean {
  return (
    a.x < b.x + b.w + buffer &&
    a.x + a.w + buffer > b.x &&
    a.y < b.y + b.h + buffer &&
    a.y + a.h + buffer > b.y
  );
}

/**
 * Pick a non-overlapping position for a branch Sticky.
 *
 * @param source   top-left of the source node (search center).
 * @param size     bbox of the Sticky being placed.
 * @param dir      half-circle direction — "right" sweeps angles in
 *                 [-90°, +90°] from +x, "left" sweeps the mirrored half.
 * @param existing rects of all other nodes on the board (exclude the source
 *                 node so we don't push away from it).
 */
export function findNonOverlappingBranchPosition(
  source: { x: number; y: number },
  size: { w: number; h: number },
  dir: "left" | "right",
  existing: ReadonlyArray<Rect>,
): { x: number; y: number } {
  const sign = dir === "left" ? -1 : 1;
  const fits = (x: number, y: number): boolean => {
    const r: Rect = { x, y, w: size.w, h: size.h };
    for (const e of existing) {
      if (rectsOverlap(r, e, OVERLAP_BUFFER)) return false;
    }
    return true;
  };

  for (let k = 0; k <= MAX_RADIUS_STEPS; k++) {
    const r = BRANCH_BASE_OFFSET + k * BRANCH_RADIUS_STEP;
    for (const deg of ANGLE_DEGREES) {
      const rad = (deg * Math.PI) / 180;
      const x = source.x + sign * r * Math.cos(rad);
      const y = source.y + r * Math.sin(rad);
      if (fits(x, y)) return { x, y };
    }
  }
  // Fallback: outermost horizontal position so the user can still find the
  // new sticky instead of having it stack atop an existing node.
  return {
    x:
      source.x +
      sign * (BRANCH_BASE_OFFSET + MAX_RADIUS_STEPS * BRANCH_RADIUS_STEP),
    y: source.y,
  };
}
