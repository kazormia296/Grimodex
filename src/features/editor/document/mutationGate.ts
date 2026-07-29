import type { LoadedEditorBinding } from "./types";
import { documentKeyFromBinding, encodeDocumentKey } from "./documentKey";

export interface SaveSnapshot {
  binding: LoadedEditorBinding;
  editGeneration: number;
}

export interface EditorMutationGate {
  beginLoad(): void;
  commitLoad(binding: LoadedEditorBinding): void;
  failLoad(): void;
  runProgrammatic<T>(fn: () => T): T;
  isProgrammatic(): boolean;
  markEdited(): void;
  captureSave(): SaveSnapshot | null;
  mayClearDirty(snapshot: SaveSnapshot): boolean;
  /**
   * Advance a successfully persisted version without clearing edits that
   * arrived during the save. Returns whether dirty may be cleared.
   */
  commitSave(
    snapshot: SaveSnapshot,
    persistedBinding: LoadedEditorBinding,
  ): boolean;
  /**
   * Adopt the persisted binding announced by another local editor instance
   * displaying the exact same document. This advances only the OCC base; it
   * never clears this instance's dirty generation.
   */
  advancePeerSave(persistedBinding: LoadedEditorBinding): boolean;
}

function sameBinding(
  left: LoadedEditorBinding,
  right: LoadedEditorBinding,
): boolean {
  return left === right;
}

/**
 * Owns the invariants shared by loading, TipTap programmatic updates, and
 * autosave. It intentionally has no React dependency so the transition rules
 * can be tested without mounting the editor.
 */
export function createEditorMutationGate(): EditorMutationGate {
  let binding: LoadedEditorBinding | null = null;
  let loadReady = false;
  let editGeneration = 0;
  let programmaticDepth = 0;

  return {
    beginLoad() {
      binding = null;
      loadReady = false;
    },

    commitLoad(nextBinding) {
      binding = nextBinding;
      loadReady = true;
    },

    failLoad() {
      binding = null;
      loadReady = false;
    },

    runProgrammatic<T>(fn: () => T): T {
      programmaticDepth++;
      try {
        return fn();
      } finally {
        programmaticDepth--;
      }
    },

    isProgrammatic() {
      return programmaticDepth > 0;
    },

    markEdited() {
      if (!loadReady || programmaticDepth > 0) return;
      editGeneration++;
    },

    captureSave() {
      if (!loadReady || !binding) return null;
      return { binding, editGeneration };
    },

    mayClearDirty(snapshot) {
      return (
        loadReady &&
        binding !== null &&
        sameBinding(binding, snapshot.binding) &&
        editGeneration === snapshot.editGeneration
      );
    },

    commitSave(snapshot, persistedBinding) {
      if (!loadReady || binding !== snapshot.binding) return false;
      const currentKey = encodeDocumentKey(documentKeyFromBinding(binding));
      const persistedKey = encodeDocumentKey(
        documentKeyFromBinding(persistedBinding),
      );
      if (currentKey !== persistedKey) return false;
      binding = persistedBinding;
      return editGeneration === snapshot.editGeneration;
    },

    advancePeerSave(persistedBinding) {
      if (!loadReady || !binding) return false;
      const currentKey = encodeDocumentKey(documentKeyFromBinding(binding));
      const persistedKey = encodeDocumentKey(
        documentKeyFromBinding(persistedBinding),
      );
      if (currentKey !== persistedKey) return false;
      if (
        "loadedVersion" in binding &&
        "loadedVersion" in persistedBinding &&
        persistedBinding.loadedVersion < binding.loadedVersion
      ) {
        return false;
      }
      binding = persistedBinding;
      return true;
    },
  };
}
