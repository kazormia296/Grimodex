import type { LoadedEditorBinding } from "./types";

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
  };
}
