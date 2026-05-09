import { create } from "zustand";

interface MatrixDataVersionState {
  version: number;
  bump: () => void;
}

export const useMatrixDataVersionStore = create<MatrixDataVersionState>()(
  (set) => ({
    version: 0,
    bump: () => set((s) => ({ version: s.version + 1 })),
  }),
);

// Imperative bump for non-React callers (write APIs).
// Writes that mutate scene_codex_mentions or scene_beat_pov_cache should
// call this so that a mounted MatrixPanel knows to refresh.
export function bumpMatrixDataVersion(): void {
  useMatrixDataVersionStore.getState().bump();
}
