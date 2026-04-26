import type { TreeNodeData } from "@/features/tree/treeStore";
import type { LayoutOutput } from "./types";

const CLUSTER_RADIUS = 220;
const CLUSTER_GAP_X = 600;
const Y_CENTER = 400;
const CODEX_Y = 80;

export function clusterByCodexRef(
  scenes: TreeNodeData[],
  codexIds: string[],
  getRef: (scene: TreeNodeData) => string | null,
  codexPositions: Map<string, { x: number; y: number }>,
): LayoutOutput {
  const result: LayoutOutput = new Map();

  // Group scenes by reference ID (null → "unassigned")
  const groups = new Map<string | null, TreeNodeData[]>();
  for (const scene of scenes) {
    const ref = getRef(scene);
    const key = ref ?? null;
    const group = groups.get(key) ?? [];
    group.push(scene);
    groups.set(key, group);
  }

  // Determine cluster center X positions
  // Assigned clusters are laid out left-to-right by codexIds order
  let clusterX = CLUSTER_GAP_X / 2;
  const clusterCenters = new Map<string | null, { x: number; y: number }>();

  for (const codexId of codexIds) {
    if (groups.has(codexId)) {
      clusterCenters.set(codexId, { x: clusterX, y: Y_CENTER });
      // Place codex node above the cluster center
      codexPositions.set(`codex:${codexId}`, { x: clusterX, y: CODEX_Y });
      clusterX += CLUSTER_GAP_X;
    }
  }

  // Unassigned cluster goes to the right
  if (groups.has(null)) {
    clusterCenters.set(null, { x: clusterX, y: Y_CENTER });
  }

  // Arrange scenes in each cluster in a circle (or grid for large clusters)
  for (const [key, clusterScenes] of groups) {
    const center = clusterCenters.get(key) ?? { x: clusterX, y: Y_CENTER };
    const n = clusterScenes.length;

    if (n === 1) {
      result.set(`scene:${clusterScenes[0].id}`, { x: center.x, y: center.y });
    } else {
      for (let i = 0; i < n; i++) {
        const angle = (2 * Math.PI * i) / n - Math.PI / 2;
        const r = Math.min(CLUSTER_RADIUS, 60 + n * 30);
        result.set(`scene:${clusterScenes[i].id}`, {
          x: center.x + r * Math.cos(angle),
          y: center.y + r * Math.sin(angle),
        });
      }
    }
  }

  return result;
}
