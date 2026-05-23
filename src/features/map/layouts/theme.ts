import type { LayoutInput, LayoutOutput } from "./types";
import type { ForceLayoutEngine } from "./forceEngine";
import type { ForceNode, ForceLink } from "./forceLayout.worker";
import { parseTags } from "@/features/codex/components/EntryCard";
import { posToNodeKey } from "./posToNodeKey";
import { hashStringToSeed } from "./seededRandom";

export async function layoutTheme(
  input: LayoutInput,
  engine: ForceLayoutEngine,
  onProgress?: (alpha: number) => void,
): Promise<LayoutOutput> {
  const { scenes, codexEntries } = input;

  const initialPos = new Map<string, { x: number; y: number }>();
  for (const p of input.positions) {
    const key = posToNodeKey(p);
    if (key && (key.startsWith("scene:") || key.startsWith("codex:"))) {
      initialPos.set(key, { x: p.x, y: p.y });
    }
  }

  // Build force nodes: scenes + codex entries visible in this view
  const nodes: ForceNode[] = [
    ...scenes.map((s) => {
      const key = `scene:${s.id}`;
      const seed = initialPos.get(key);
      return {
        id: key,
        tags: s.tags ?? [],
        ...(seed ? { x: seed.x, y: seed.y } : {}),
      };
    }),
    ...codexEntries.map((e) => {
      const key = `codex:${e.id}`;
      const seed = initialPos.get(key);
      return {
        id: key,
        tags: parseTags(e.tagsCache).map((t) => t.name),
        ...(seed ? { x: seed.x, y: seed.y } : {}),
      };
    }),
  ];

  const presentNodeIds = new Set(nodes.map((n) => n.id));
  const links: ForceLink[] = [];
  for (const scene of scenes) {
    const sceneKey = `scene:${scene.id}`;
    if (scene.povCharacterId) {
      const targetKey = `codex:${scene.povCharacterId}`;
      if (presentNodeIds.has(targetKey)) {
        links.push({ source: sceneKey, target: targetKey, strength: 0.4 });
      }
    }
    if (scene.locationId) {
      const targetKey = `codex:${scene.locationId}`;
      if (presentNodeIds.has(targetKey)) {
        links.push({ source: sceneKey, target: targetKey, strength: 0.4 });
      }
    }
  }

  if (input.userEdges?.length) {
    const posById = new Map(input.positions.map((p) => [p.id, p]));
    for (const edge of input.userEdges) {
      const sourceKey = posToNodeKey(posById.get(edge.fromPositionId));
      const targetKey = posToNodeKey(posById.get(edge.toPositionId));
      if (
        sourceKey &&
        targetKey &&
        presentNodeIds.has(sourceKey) &&
        presentNodeIds.has(targetKey)
      ) {
        links.push({ source: sourceKey, target: targetKey, strength: 0.4 });
      }
    }
  }

  const randomSeed = input.boardId
    ? hashStringToSeed(input.boardId)
    : 42;

  const output = await engine.run(
    { nodes, links, options: { randomSeed } },
    onProgress,
  );

  const result: LayoutOutput = new Map();
  for (const pos of output.positions) {
    result.set(pos.id, { x: pos.x, y: pos.y });
  }

  // Hybrid: pinned nodes keep their stored position regardless of force output
  for (const p of input.positions) {
    if (!p.pinned) continue;
    if (p.treeNodeId && p.nodeRefType === "scene")
      result.set(`scene:${p.treeNodeId}`, { x: p.x, y: p.y });
    else if (p.codexEntryId)
      result.set(`codex:${p.codexEntryId}`, { x: p.x, y: p.y });
  }

  return result;
}
