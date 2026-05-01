import { useUnplacedBeatsStore } from "./unplacedBeatsStore";
import type { UnplacedBeat } from "./unplacedBeatsStore";
import { extractUnplacedBeatPreview } from "./unplacedBeatPreview";
import { saveSceneBeatsOnly, loadSceneFull } from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";

/**
 * Add an unplaced beat to a scene from the Grid panel (no Editor required).
 *
 * Hydrates the in-memory store from DB first when the scene has never been
 * opened in Editor — otherwise the store is empty and we'd overwrite existing
 * beats with just the new one (data-loss bug).
 */
export async function addUnplacedBeatFromGrid(
  sceneId: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  // Hydrate store from DB if the scene was never loaded in Editor
  const storeBeats = useUnplacedBeatsStore.getState().getBeats(sceneId);
  if (storeBeats.length === 0) {
    try {
      const { unplacedBeatsDoc } = await loadSceneFull(sceneId);
      const parsed: unknown = JSON.parse(unplacedBeatsDoc);
      if (Array.isArray(parsed)) {
        useUnplacedBeatsStore
          .getState()
          .setBeats(sceneId, parsed as UnplacedBeat[], "load");
      }
    } catch {
      // DB row missing or malformed JSON — treat as empty, continue
    }
  }

  const newBeat: UnplacedBeat = {
    id: crypto.randomUUID(),
    beatType: "free",
    pov: null,
    collapsed: false,
    content: [{ type: "text", text: trimmed }],
  };

  useUnplacedBeatsStore.getState().addBeat(sceneId, newBeat);

  const beats = useUnplacedBeatsStore.getState().getBeats(sceneId);
  const unplacedBeatsDoc = JSON.stringify(beats);
  const unplacedBeatPreview = extractUnplacedBeatPreview(beats) || null;

  await saveSceneBeatsOnly(sceneId, { unplacedBeatsDoc, unplacedBeatPreview });

  // Optimistic update so the Grid card shows the new bullet without reloading
  useTreeStore.setState((s) => ({
    nodes: s.nodes.map((n) =>
      n.id === sceneId ? { ...n, unplacedBeatPreview } : n,
    ),
  }));
}
