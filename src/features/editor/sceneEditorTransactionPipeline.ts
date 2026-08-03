import type { Transaction } from "@tiptap/pm/state";
import { extractUnplacedBeatPreview } from "@/features/editor/beat/unplacedBeatPreview";
import { transactionTouchesSceneBeat } from "@/features/editor/beat/transactionTouchesSceneBeat";
import {
  buildSceneBeatIndex,
  mapSceneBeatIndex,
  placedBeatPreviewFromIndex,
  updateSceneBeatIndex,
  type SceneBeatIndex,
} from "@/features/editor/beat/sceneBeatIndex";
import {
  getEditorTimelapseCapture,
  serializeTransactionSteps,
} from "@/features/editor/editorEventPolicy";
import {
  useUnplacedBeatsStore,
  type UnplacedBeat,
} from "@/features/editor/beat/unplacedBeatsStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  recordChangeEvent,
  type RecordEventInput,
} from "@/features/timelapse/recorder";
import { debugLog } from "@/lib/debugLog";
import { markEnd, markStart } from "@/lib/perfLog";

export interface SceneBeatIndexState {
  sceneId: string;
  index: SceneBeatIndex;
}

export interface SceneBeatIndexRef {
  current: SceneBeatIndexState | null;
}

interface UnplacedBeatStorePort {
  getBeats: (sceneId: string) => UnplacedBeat[];
  addBeat: (sceneId: string, beat: UnplacedBeat) => void;
  removeBeat: (sceneId: string, beatId: string) => void;
}

export interface SceneEditorTransactionPorts {
  recordChangeEvent: (input: RecordEventInput) => void;
  reportTimelapseFailure: (error: unknown) => void;
  getUnplacedBeatStore: () => UnplacedBeatStorePort;
  setNodePreview: (
    sceneId: string,
    preview: { placed: string | null; unplaced: string | null },
  ) => void;
  markStart: (name: string) => void;
  markEnd: (name: string) => void;
}

const defaultPorts: SceneEditorTransactionPorts = {
  recordChangeEvent,
  reportTimelapseFailure(_error) {
    // Capturing an auxiliary timelapse event must never interrupt editing.
    // The thrown value can contain serialized Step payloads or SQL params, so
    // report only fixed, content-free metadata to the production-safe logger.
    debugLog.warn("timelapse", "editor capture failed", {
      sensitivity: "safe",
      fields: {
        operation: "recordChangeEvent",
        outcome: "failed",
      },
    });
  },
  getUnplacedBeatStore: () => useUnplacedBeatsStore.getState(),
  setNodePreview: (sceneId, preview) =>
    useTreeStore.getState().setNodePreview(sceneId, preview),
  markStart,
  markEnd,
};

export interface SceneEditorTransactionInput {
  transaction: Transaction;
  id: string | null;
  isEntryMode: boolean;
  isCodexMode: boolean;
  isSnippetMode: boolean;
  isChronicleEventMode: boolean;
  isApplyingExternalUpdate: boolean;
  beatIndexRef: SceneBeatIndexRef;
}

/**
 * Canonical transaction side-effect pipeline shared by the tab and Linear
 * editors. `emitUpdate:false` still emits `transaction`; callers therefore
 * pass the external-update window explicitly so loads/peer sync update only
 * the local Beat index and never become writing history or persisted sidecars.
 */
export function handleSceneEditorTransaction(
  {
    transaction,
    id,
    isEntryMode,
    isCodexMode,
    isSnippetMode,
    isChronicleEventMode,
    isApplyingExternalUpdate,
    beatIndexRef,
  }: SceneEditorTransactionInput,
  ports: SceneEditorTransactionPorts = defaultPorts,
): void {
  if (!transaction.docChanged) return;

  const capture = getEditorTimelapseCapture({
    id,
    isEntryMode,
    isCodexMode,
    isSnippetMode,
    isChronicleEventMode,
    isApplyingExternalUpdate,
  });
  if (capture) {
    try {
      ports.recordChangeEvent({
        domain: capture.domain,
        opType: "doc.step",
        sceneId: capture.sceneId,
        entityType: capture.entityType,
        entityId: capture.entityId,
        payload: {
          steps: serializeTransactionSteps(transaction.steps),
        },
      });
    } catch (error) {
      ports.reportTimelapseFailure(error);
    }
  }

  // Codex, Snippet, and Chronicle bodies have no scene Beat sidecars.
  if (isEntryMode || !id) return;

  const existingIndex = beatIndexRef.current;
  // A scene load replaces the entire document. Build the target scene's index
  // once instead of scanning the previous scene before applying the replace.
  if (isApplyingExternalUpdate && existingIndex?.sceneId !== id) {
    beatIndexRef.current = {
      sceneId: id,
      index: buildSceneBeatIndex(transaction.doc),
    };
    return;
  }

  const sourceIndex =
    existingIndex?.sceneId === id &&
    existingIndex.index.doc === transaction.before
      ? existingIndex.index
      : buildSceneBeatIndex(transaction.before);

  // Ordinary paragraph edits cannot change placed Beat membership or preview.
  // Keep positions current through StepMap without a document traversal.
  if (!transactionTouchesSceneBeat(transaction)) {
    beatIndexRef.current = {
      sceneId: id,
      index: mapSceneBeatIndex(
        sourceIndex,
        transaction.mapping,
        transaction.doc,
      ),
    };
    return;
  }

  const beatUpdate = updateSceneBeatIndex(sourceIndex, transaction);
  beatIndexRef.current = {
    sceneId: id,
    index: beatUpdate.index,
  };

  // Loads, peer sync, and sidecar mark application update the local index but
  // must never reconcile persisted unplaced state or publish live previews.
  if (isApplyingExternalUpdate) return;

  ports.markStart("editor.onTransaction");
  const store = ports.getUnplacedBeatStore();
  const unplacedIds = new Set(store.getBeats(id).map((beat) => beat.id));

  for (const snapshot of beatUpdate.removed) {
    if (unplacedIds.has(snapshot.id)) continue;
    store.addBeat(id, {
      id: snapshot.id,
      beatType: snapshot.beatType as UnplacedBeat["beatType"],
      pov: snapshot.pov,
      collapsed: false,
      content: snapshot.content as UnplacedBeat["content"],
    });
    unplacedIds.add(snapshot.id);
  }

  for (const addedId of beatUpdate.addedIds) {
    if (!unplacedIds.has(addedId)) continue;
    store.removeBeat(id, addedId);
    unplacedIds.delete(addedId);
  }

  ports.markStart("editor.onTransaction.treeMirror");
  const placed = placedBeatPreviewFromIndex(beatUpdate.index);
  const unplaced = extractUnplacedBeatPreview(store.getBeats(id));
  ports.setNodePreview(id, {
    placed: placed === "[]" ? null : placed,
    unplaced: unplaced === "[]" ? null : unplaced,
  });
  ports.markEnd("editor.onTransaction.treeMirror");
  ports.markEnd("editor.onTransaction");
}
