import type { LayoutInput, LayoutOutput } from "./types";
import type { ForceLayoutEngine } from "./forceEngine";
import type { ForceNode, ForceLink } from "./forceLayout.worker";

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
      tags: [] as string[],
    })),
    ...codexEntries.map((e) => ({
      id: `codex:${e.id}`,
      tags: [] as string[],
    })),
  ];

  // Build links from POV/location references
  const links: ForceLink[] = [];
  for (const scene of scenes) {
    if (scene.povCharacterId) {
      links.push({
        source: `scene:${scene.id}`,
        target: `codex:${scene.povCharacterId}`,
        strength: 0.4,
      });
    }
    if (scene.locationId) {
      links.push({
        source: `scene:${scene.id}`,
        target: `codex:${scene.locationId}`,
        strength: 0.4,
      });
    }
  }

  const output = await engine.run({ nodes, links }, onProgress);

  const result: LayoutOutput = new Map();
  for (const pos of output.positions) {
    result.set(pos.id, { x: pos.x, y: pos.y });
  }
  return result;
}
