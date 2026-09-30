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
  type TimelapseAcceptedEnqueueReceipt,
  type TimelapseDocumentRef,
  type RecordEventInput,
} from "@/features/timelapse/recorder";
import {
  createTimelapseDocumentCaptureAccumulator,
  isTimelapseReplacementFenceActiveForDocument,
  type TimelapseDocumentCaptureAccumulator,
  type TimelapseDocumentIdentity,
} from "@/features/timelapse/documentCoverage";
import { documentKeyFromBinding } from "@/features/editor/document/documentKey";
import { debugLog } from "@/lib/debugLog";
import { markEnd, markStart } from "@/lib/perfLog";
import type { LoadedEditorBinding } from "@/features/editor/document/types";

export interface SceneBeatIndexState {
  sceneId: string;
  index: SceneBeatIndex;
}

export interface SceneBeatIndexRef {
  current: SceneBeatIndexState | null;
}

/**
 * Immutable authority of the document that is actually present in an editor.
 *
 * A component can be reused while Project/Phase props already point at the
 * next target. Timelapse capture must therefore read this committed descriptor
 * from a ref owned by the load transaction, never from render-time props.
 */
export interface LoadedTimelapseDescriptor {
  readonly projectId: string;
  readonly binding: LoadedEditorBinding;
  readonly documentIdentity: TimelapseDocumentIdentity;
  readonly captureAccumulator: TimelapseDocumentCaptureAccumulator;
  /** Latest accepted doc.step capability for the loaded body. */
  document?: TimelapseDocumentRef;
}

export function createLoadedTimelapseDescriptor(
  projectId: string,
  binding: LoadedEditorBinding,
): LoadedTimelapseDescriptor {
  const normalizedBinding =
    binding.kind === "codex" && binding.phaseId === "__base__"
      ? { ...binding, phaseId: null }
      : { ...binding };
  return {
    projectId,
    binding: normalizedBinding,
    documentIdentity:
      normalizedBinding.kind === "tree"
        ? {
            projectId,
            domain: "editor",
            entityType: "scene",
            entityId: normalizedBinding.id,
            storage: normalizedBinding.storage,
          }
        : normalizedBinding.kind === "codex"
          ? {
              projectId,
              domain: "codex",
              entityType: "codex_entry",
              entityId: normalizedBinding.id,
            }
          : {
              projectId,
              domain: "snippet",
              entityType: "snippet",
              entityId: normalizedBinding.id,
            },
    captureAccumulator: createTimelapseDocumentCaptureAccumulator(
      normalizedBinding.kind === "tree"
        ? {
            projectId,
            domain: "editor",
            entityType: "scene",
            entityId: normalizedBinding.id,
            storage: normalizedBinding.storage,
          }
        : normalizedBinding.kind === "codex"
          ? {
              projectId,
              domain: "codex",
              entityType: "codex_entry",
              entityId: normalizedBinding.id,
            }
          : {
              projectId,
              domain: "snippet",
              entityType: "snippet",
              entityId: normalizedBinding.id,
            },
    ),
  };
}

interface UnplacedBeatStorePort {
  getBeats: (sceneId: string) => UnplacedBeat[];
  addBeat: (sceneId: string, beat: UnplacedBeat) => void;
  removeBeat: (sceneId: string, beatId: string) => void;
}

export interface SceneEditorTransactionPorts {
  recordChangeEvent: (
    input: RecordEventInput,
  ) => TimelapseAcceptedEnqueueReceipt | null | void;
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
  timelapseDescriptor: LoadedTimelapseDescriptor | null;
  /** Target scene used only while a programmatic scene load rebuilds Beat state. */
  beatSceneId: string | null;
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
    timelapseDescriptor,
    beatSceneId,
    isApplyingExternalUpdate,
    beatIndexRef,
  }: SceneEditorTransactionInput,
  ports: SceneEditorTransactionPorts = defaultPorts,
): void {
  if (!transaction.docChanged) return;

  const binding = timelapseDescriptor?.binding ?? null;
  const capture = binding
    ? getEditorTimelapseCapture({
        id: binding.id,
        isEntryMode: binding.kind !== "tree",
        isCodexMode: binding.kind === "codex",
        isCodexPhaseMode: binding.kind === "codex" && binding.phaseId !== null,
        isSnippetMode: binding.kind === "snippet",
        isChronicleEventMode: binding.kind === "chronicle-event",
        isApplyingExternalUpdate,
      })
    : null;
  if (capture && binding) {
    const documentKey = documentKeyFromBinding(binding);
    if (
      isTimelapseReplacementFenceActiveForDocument(
        timelapseDescriptor!.projectId,
        documentKey,
      )
    ) {
      // A replacement fence is admission denial, not a capture failure. Keep
      // the prior epoch retryable while the PM transaction is filtered by the
      // editor's synchronous editable/admission guard.
      return;
    }
    try {
      const receipt = ports.recordChangeEvent({
        domain: capture.domain,
        opType: "doc.step",
        sceneId: capture.sceneId,
        entityType: capture.entityType,
        entityId: capture.entityId,
        projectId: timelapseDescriptor!.projectId,
        ...(binding.kind === "tree"
          ? { documentStorage: binding.storage }
          : {}),
        payload: {
          steps: serializeTransactionSteps(transaction.steps),
        },
      });
      if (receipt?.document) {
        timelapseDescriptor!.document = receipt.document;
      }
      timelapseDescriptor!.captureAccumulator.accept(receipt ?? null);
      if (timelapseDescriptor!.captureAccumulator.broken) {
        timelapseDescriptor!.document = undefined;
      }
    } catch (error) {
      timelapseDescriptor!.captureAccumulator.markBroken();
      timelapseDescriptor!.document = undefined;
      ports.reportTimelapseFailure(error);
    }
  }

  const id = binding?.kind === "tree" ? binding.id : beatSceneId;
  const isEntryMode = binding ? binding.kind !== "tree" : id === null;

  // With no committed binding, only the programmatic scene-load transaction
  // may rebuild the local Beat index. A bystander transaction in the load gap
  // owns neither persistence nor history.
  if (!binding && !isApplyingExternalUpdate) return;

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
