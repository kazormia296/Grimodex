import type { LayoutInput, LayoutOutput } from "./types";
import type { ForceLayoutEngine } from "./forceEngine";
import type { ForceNode, ForceLink } from "./forceLayout.worker";
import { parseTags } from "@/features/codex/components/EntryCard";

export async function layoutTheme(
  input: LayoutInput,
  engine: ForceLayoutEngine,
  onProgress?: (alpha: number) => void,
): Promise<LayoutOutput> {
  const { scenes, codexEntries } = input;

  // Build force nodes: scenes + codex entries visible in this view
  const nodes: ForceNode[] = [
    ...scenes.map((s) => ({
      id: `scene:${s.id}`,
      tags: s.tags ?? [],
    })),
    ...codexEntries.map((e) => ({
      id: `codex:${e.id}`,
      tags: parseTags(e.tagsCache).map((t) => t.name),
    })),
  ];

  // Build links from POV/location references.
  // d3-force-link throws "node not found: <id>" if a link references a node
  // outside the simulation set, so we must drop any link whose target codex
  // is not on this board (positionedCodexIds 経由で visibleCodex に絞られている).
  // Without this guard, the worker rejects, buildNodes() throws unhandled,
  // and forceLayoutRunning is stuck at true (progress bar永続化＋ドラッグ不可).
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

  const output = await engine.run({ nodes, links }, onProgress);

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
