import { create } from "zustand";
import type { GroupIndex } from "./tabStore";

interface EditorSessionState {
  dirtyDocumentIds: Set<string>;
  focusRequests: Record<GroupIndex, boolean>;
  resetForProject(): void;
  requestEditorFocus(group: GroupIndex): void;
  consumeEditorFocusRequest(group: GroupIndex): boolean;
  setDocumentDirty(documentId: string, dirty: boolean): void;
}

/** Ephemeral editor-session state; it is never part of persisted tab state. */
export const useEditorSessionStore = create<EditorSessionState>()(
  (set, get) => ({
    dirtyDocumentIds: new Set<string>(),
    focusRequests: { 0: false, 1: false },
    resetForProject() {
      set({
        dirtyDocumentIds: new Set<string>(),
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
    setDocumentDirty(documentId, dirty) {
      const current = get().dirtyDocumentIds;
      if (dirty === current.has(documentId)) return;
      const next = new Set(current);
      if (dirty) next.add(documentId);
      else next.delete(documentId);
      set({ dirtyDocumentIds: next });
    },
  }),
);
