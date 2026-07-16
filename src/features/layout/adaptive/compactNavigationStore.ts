import { create } from "zustand";

export type CompactSurface = "editor" | string;
export type CompactSheetKind =
  | "scene-picker"
  | "document-picker"
  | "command-center";

export interface CompactNavigationState {
  activeSurface: CompactSurface;
  backStack: CompactSurface[];
  sheet: { kind: CompactSheetKind } | null;
  openSurface: (surface: CompactSurface) => void;
  goBack: () => boolean;
  openSheet: (kind: CompactSheetKind) => void;
  closeSheet: () => void;
  reset: () => void;
}

const initialState = {
  activeSurface: "editor" as CompactSurface,
  backStack: [] as CompactSurface[],
  sheet: null,
};

export const useCompactNavigationStore = create<CompactNavigationState>(
  (set, get) => ({
    ...initialState,
    openSurface(surface) {
      if (surface === get().activeSurface) return;
      set((state) => ({
        activeSurface: surface,
        backStack: [...state.backStack, state.activeSurface],
      }));
    },
    goBack() {
      const state = get();
      const previous = state.backStack.at(-1);
      if (previous === undefined) return false;
      set({ activeSurface: previous, backStack: state.backStack.slice(0, -1) });
      return true;
    },
    openSheet(kind) {
      set({ sheet: { kind } });
    },
    closeSheet() {
      set({ sheet: null });
    },
    reset() {
      set({ ...initialState, backStack: [] });
    },
  }),
);
