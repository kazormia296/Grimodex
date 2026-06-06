import { create } from "zustand";

export interface ExternalEditConflict {
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
  shiftConflict: (sceneId: string) => void;
  bumpReloadNonce: (sceneId: string) => void;
  clear: () => void;
}

export const useExternalWriteStore = create<ExternalWriteState>((set, get) => ({
  conflicts: [],
  reloadNonce: {},

  pushConflict: (conflict) => {
    const exists = get().conflicts.some((c) => c.sceneId === conflict.sceneId);
    if (exists) return;
    set((s) => ({ conflicts: [...s.conflicts, conflict] }));
  },

  shiftConflict: (sceneId) => {
    set((s) => ({
      conflicts: s.conflicts.filter((c) => c.sceneId !== sceneId),
    }));
  },

  bumpReloadNonce: (sceneId) => {
    set((s) => ({
      reloadNonce: {
        ...s.reloadNonce,
        [sceneId]: (s.reloadNonce[sceneId] ?? 0) + 1,
      },
    }));
  },

  clear: () => set({ conflicts: [], reloadNonce: {} }),
}));
