import { useUnplacedBeatsStore } from "./unplacedBeatsStore";
import type { UnplacedBeat } from "./unplacedBeatsStore";
import { saveSceneBeatsOnly, loadSceneFull } from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { runGridBeatMutation } from "./gridBeatMutationQueue";

function hasHydratedScene(sceneId: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    useUnplacedBeatsStore.getState().sceneBeats,
    sceneId,
  );
}

/**
 * Resolve the full Beat aggregate before opening Grid's local add editor.
 *
 * Strict lifecycle leases block new reads, so a typed add-Beat draft must not
 * defer this prerequisite SELECT until participant flush. An explicit empty
 * array is cached as hydrated; malformed/unavailable data rejects instead of
 * being overwritten as though the scene had no existing Beats.
 */
export async function prepareUnplacedBeatsForGrid(
  sceneId: string,
): Promise<void> {
  if (hasHydratedScene(sceneId)) return;
  const { unplacedBeatsDoc } = await loadSceneFull(sceneId);
  const parsed: unknown = JSON.parse(unplacedBeatsDoc);
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid unplaced Beats document for scene: ${sceneId}`);
  }
  useUnplacedBeatsStore
    .getState()
    .setBeats(sceneId, parsed as UnplacedBeat[], "load");
}

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
  await saveUnplacedBeatDraftFromGrid(sceneId, crypto.randomUUID(), trimmed);
}

/**
 * Fixed-identity upsert used by Grid's add draft. Repeated generations update
 * the same Beat, and an empty latest generation removes an earlier in-flight
 * add instead of leaving the stale first value behind.
 */
export async function saveUnplacedBeatDraftFromGrid(
  sceneId: string,
  beatId: string,
  text: string,
): Promise<void> {
  await runGridBeatMutation(sceneId, async () => {
    await prepareUnplacedBeatsForGrid(sceneId);
    const store = useUnplacedBeatsStore.getState();
    const prevBeats = store.getBeats(sceneId);
    const trimmed = text.trim();
    const existing = prevBeats.find((beat) => beat.id === beatId);

    if (!trimmed) {
      if (!existing) return;
      store.removeBeat(sceneId, beatId);
    } else if (existing) {
      store.updateBeat(sceneId, beatId, {
        content: [{ type: "text", text: trimmed }],
      });
    } else {
      store.addBeat(sceneId, {
        id: beatId,
        beatType: "free",
        pov: null,
        collapsed: false,
        content: [{ type: "text", text: trimmed }],
      });
    }

    const unplacedBeatsDoc = JSON.stringify(store.getBeats(sceneId));
    let unplacedBeatPreview: string | null;
    try {
      ({ unplacedBeatPreview } = await saveSceneBeatsOnly(sceneId, {
        unplacedBeatsDoc,
      }));
    } catch (error) {
      store.setBeats(sceneId, prevBeats);
      throw error;
    }
    useTreeStore
      .getState()
      .setNodePreview(sceneId, { unplaced: unplacedBeatPreview });
  });
}
