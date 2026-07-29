import { create } from "zustand";
import type { GroupIndex } from "./tabStore";
import {
  documentIdFromKey,
  encodeDocumentKey,
  type DocumentKey,
  type EditorInstanceId,
} from "./document/documentKey";
import { setUnresolvedEditorChanges } from "@/lib/editorQuiescence";

type DocumentReference = string | DocumentKey;

const LEGACY_INSTANCE = "__legacy__";

function referenceIdentity(reference: DocumentReference): {
  encoded: string;
  documentId: string;
} {
  if (typeof reference === "string") {
    return {
      encoded: `legacy:${encodeURIComponent(reference)}`,
      documentId: reference,
    };
  }
  return {
    encoded: encodeDocumentKey(reference),
    documentId: documentIdFromKey(reference),
  };
}

interface EditorSessionState {
  /** Compatibility projection: raw ids dirty in at least one live instance. */
  dirtyDocumentIds: Set<string>;
  /** Canonical document key → dirty editor instance ids. */
  dirtyEditorInstances: Record<string, Set<string>>;
  documentIdsByKey: Record<string, string>;
  focusRequests: Record<GroupIndex, boolean>;
  resetForProject(): void;
  requestEditorFocus(group: GroupIndex): void;
  consumeEditorFocusRequest(group: GroupIndex): boolean;
  setDocumentDirty(
    document: DocumentReference,
    dirty: boolean,
    instanceId?: EditorInstanceId,
  ): void;
  isDocumentDirty(document: DocumentReference): boolean;
}

/** Ephemeral editor-session state; it is never part of persisted tab state. */
export const useEditorSessionStore = create<EditorSessionState>()(
  (set, get) => ({
    dirtyDocumentIds: new Set<string>(),
    dirtyEditorInstances: {},
    documentIdsByKey: {},
    focusRequests: { 0: false, 1: false },
    resetForProject() {
      setUnresolvedEditorChanges(false);
      set({
        dirtyDocumentIds: new Set<string>(),
        dirtyEditorInstances: {},
        documentIdsByKey: {},
        focusRequests: { 0: false, 1: false },
      });
    },
    requestEditorFocus(group) {
      set((state) => ({
        focusRequests: { ...state.focusRequests, [group]: true },
      }));
    },
    consumeEditorFocusRequest(group) {
      const requested = get().focusRequests[group];
      if (requested) {
        set((state) => ({
          focusRequests: { ...state.focusRequests, [group]: false },
        }));
      }
      return requested;
    },
    setDocumentDirty(document, dirty, instanceId) {
      const { encoded, documentId } = referenceIdentity(document);
      const state = get();
      const currentInstances =
        state.dirtyEditorInstances[encoded] ?? new Set<string>();
      const effectiveInstance = instanceId ?? LEGACY_INSTANCE;
      if (dirty === currentInstances.has(effectiveInstance)) return;

      const nextInstances = new Set(currentInstances);
      if (dirty) nextInstances.add(effectiveInstance);
      else nextInstances.delete(effectiveInstance);

      const dirtyEditorInstances = { ...state.dirtyEditorInstances };
      const documentIdsByKey = { ...state.documentIdsByKey };
      if (nextInstances.size > 0) {
        dirtyEditorInstances[encoded] = nextInstances;
        documentIdsByKey[encoded] = documentId;
      } else {
        delete dirtyEditorInstances[encoded];
        delete documentIdsByKey[encoded];
      }

      const dirtyDocumentIds = new Set<string>();
      for (const key of Object.keys(dirtyEditorInstances)) {
        const id = documentIdsByKey[key];
        if (id) dirtyDocumentIds.add(id);
      }
      setUnresolvedEditorChanges(dirtyDocumentIds.size > 0);
      set({ dirtyEditorInstances, documentIdsByKey, dirtyDocumentIds });
    },
    isDocumentDirty(document) {
      const { encoded } = referenceIdentity(document);
      return (get().dirtyEditorInstances[encoded]?.size ?? 0) > 0;
    },
  }),
);
