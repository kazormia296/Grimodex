import { useUnplacedBeatsStore } from "./unplacedBeatsStore";
import type { UnplacedBeat } from "./unplacedBeatsStore";
import { saveSceneBeatsOnly } from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  prepareUnplacedBeatsForGrid,
  type GridBeatWriteSnapshot,
} from "./addUnplacedBeatFromGrid";
import { runGridBeatMutation } from "./gridBeatMutationQueue";

export function beatToPlainText(beat: UnplacedBeat): string {
  return (beat.content ?? [])
    .map((n) => (typeof n.text === "string" ? n.text : ""))
    .join("");
}

async function hydrateIfEmpty(
  sceneId: string,
): Promise<{ beats: UnplacedBeat[]; writeSnapshot: GridBeatWriteSnapshot }> {
  const writeSnapshot = await prepareUnplacedBeatsForGrid(sceneId);
  return {
    beats: useUnplacedBeatsStore.getState().getBeats(sceneId),
    writeSnapshot,
  };
}

/**
 * Load the full plain-text content of a Beat at the given grid-preview index.
 * Returns null if not found (scene without beats, index out of range).
 */
export async function loadBeatTextByIndex(
  sceneId: string,
  index: number,
): Promise<{ id: string; text: string } | null> {
  const { beats } = await hydrateIfEmpty(sceneId);
  const target = beats[index];
  if (!target) return null;
  return { id: target.id, text: beatToPlainText(target) };
}

/**
 * Replace a Beat's content with plain text (or remove it if empty).
 * Saves immediately and updates the Grid preview.
 *
 * NOTE: any inline marks on the original beat are lost — the full editor is
 * the authoritative place for rich editing.
 */
export async function editUnplacedBeatFromGrid(
  sceneId: string,
  beatId: string,
  newText: string,
): Promise<void> {
  await runGridBeatMutation(sceneId, async () => {
    const trimmed = newText.trim();
    const { writeSnapshot } = await hydrateIfEmpty(sceneId);

    const store = useUnplacedBeatsStore.getState();
    const prevBeats = store.getBeats(sceneId);
    const target = prevBeats.find((b) => b.id === beatId);
    if (!target) {
      throw new Error(`Grid Beat edit target is unavailable: ${beatId}`);
    }

    if (!trimmed) {
      store.removeBeat(sceneId, beatId);
    } else {
      store.updateBeat(sceneId, beatId, {
        content: [{ type: "text", text: trimmed }],
      });
    }

    const beats = store.getBeats(sceneId);
    const unplacedBeatsDoc = JSON.stringify(beats);

    let unplacedBeatPreview: string | null;
    try {
      ({ unplacedBeatPreview } = await saveSceneBeatsOnly(sceneId, {
        unplacedBeatsDoc,
        projectId: writeSnapshot.projectId,
        baseVersion: writeSnapshot.baseVersion,
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
