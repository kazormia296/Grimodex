// Pure layout helper for Map AI branch placement.
//
// Goal: keep the branch anchor at the spawn point (where the user invoked the
// command) and place the generated card cluster in the most empty surrounding
// space, rather than scattering cards radially around the spawn.

export interface Coord {
  x: number;
  y: number;
}

export interface AiBranchLayout {
  branch: Coord;
  cards: Coord[];
}

// Sticky bounding-box dimensions used by StickyNode (visual hit area, with
// padding for safe non-overlap during placement scoring).
const STICKY_W = 200;
const STICKY_H = 120;
const GAP = 40;
const CELL_W = STICKY_W + GAP; // 240
const CELL_H = STICKY_H + GAP; // 160
// Minimum offset between branch anchor and cluster center so the cluster
// reads as distinct from the spawn point even when surrounding space is empty.
const MIN_CLUSTER_OFFSET = 320;
// Buffer around the cluster bbox used for overlap scoring.
const SCORE_BUFFER = 60;

const DIRS = [
  0,
  Math.PI / 4,
  Math.PI / 2,
  (3 * Math.PI) / 4,
  Math.PI,
  (5 * Math.PI) / 4,
  (3 * Math.PI) / 2,
  (7 * Math.PI) / 4,
];

/**
 * Compute branch + card positions for an AI branch creation.
 *
 * Branch anchor stays at the spawn point. Card cluster is placed at a fixed
 * offset from the spawn in the direction with the fewest existing nodes
 * intersecting the cluster bounding box (plus a safety buffer).
 */
export function computeAiBranchLayout(
  spawnX: number,
  spawnY: number,
  count: number,
  existing: ReadonlyArray<Coord>,
): AiBranchLayout {
  const branch: Coord = { x: spawnX, y: spawnY };
  if (count <= 0) return { branch, cards: [] };

  const cols = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / cols);
  const clusterW = cols * CELL_W;
  const clusterH = rows * CELL_H;

  const offset = Math.max(
    MIN_CLUSTER_OFFSET,
    Math.hypot(clusterW, clusterH) / 2 + 200,
  );

  let best: { cx: number; cy: number; score: number } | null = null;
  for (const angle of DIRS) {
    const cx = spawnX + Math.cos(angle) * offset;
    const cy = spawnY + Math.sin(angle) * offset;
    const halfW = clusterW / 2 + SCORE_BUFFER;
    const halfH = clusterH / 2 + SCORE_BUFFER;
    let score = 0;
    for (const p of existing) {
      if (
        p.x >= cx - halfW &&
        p.x <= cx + halfW &&
        p.y >= cy - halfH &&
        p.y <= cy + halfH
      ) {
        score += 1;
      }
    }
    if (best === null || score < best.score) {
      best = { cx, cy, score };
    }
  }
  const { cx, cy } = best!;

  // Center the grid on (cx, cy). Positions are top-left of each sticky.
  const cards: Coord[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    cards.push({
      x: Math.round(cx - clusterW / 2 + c * CELL_W + GAP / 2),
      y: Math.round(cy - clusterH / 2 + r * CELL_H + GAP / 2),
    });
  }

  return { branch, cards };
}
