import { create } from "zustand";
import {
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import {
  clearExternalEditConflictRegistry,
  registerExternalEditConflict,
  unregisterExternalEditConflict,
} from "@/lib/externalEditConflictRegistry";

type DocumentReference = string | DocumentKey;

export function externalDocumentStateKey(document: DocumentReference): string {
  return typeof document === "string" ? document : encodeDocumentKey(document);
}

export interface ExternalEditConflict {
  /** Canonical identity for editor-aware writes. `sceneId` remains for logs/UI. */
  documentKey?: DocumentKey;
  sceneId: string;
  domain: string;
  opType: string;
  entityId: string | null;
}

interface ExternalWriteState {
  conflicts: ExternalEditConflict[];
  /** sceneId → monotonic nonce; EditorPane watches to reload clean buffers. */
  reloadNonce: Record<string, number>;
  pushConflict: (conflict: ExternalEditConflict) => void;
  shiftConflict: (document: DocumentReference) => void;
  bumpReloadNonce: (document: DocumentReference) => void;
  clear: () => void;
}

export const useExternalWriteStore = create<ExternalWriteState>((set, get) => ({
  conflicts: [],
  reloadNonce: {},

  pushConflict: (conflict) => {
    const key = externalDocumentStateKey(
      conflict.documentKey ?? conflict.sceneId,
    );
    const exists = get().conflicts.some(
      (candidate) =>
        externalDocumentStateKey(candidate.documentKey ?? candidate.sceneId) ===
        key,
    );
    if (exists) return;
    set((s) => ({ conflicts: [...s.conflicts, conflict] }));
    registerExternalEditConflict(key, {
      documentId: conflict.documentKey?.id ?? conflict.sceneId,
      documentKind: conflict.documentKey?.kind ?? null,
    });
  },

  shiftConflict: (document) => {
    const key = externalDocumentStateKey(document);
    set((s) => ({
      conflicts: s.conflicts.filter(
        (conflict) =>
          externalDocumentStateKey(conflict.documentKey ?? conflict.sceneId) !==
          key,
      ),
    }));
    unregisterExternalEditConflict(key);
  },

  bumpReloadNonce: (document) => {
    const key = externalDocumentStateKey(document);
    set((s) => ({
      reloadNonce: {
        ...s.reloadNonce,
        [key]: (s.reloadNonce[key] ?? 0) + 1,
      },
    }));
  },

  clear: () => {
    clearExternalEditConflictRegistry();
    set({ conflicts: [], reloadNonce: {} });
  },
}));
