import { create } from "zustand";

interface CursorSettingsState {
  cursorAnimation: boolean;
  toggleCursorAnimation: () => void;
}

export const useCursorSettingsStore = create<CursorSettingsState>()((set) => ({
  cursorAnimation: true,
  toggleCursorAnimation: () =>
    set((s) => ({ cursorAnimation: !s.cursorAnimation })),
}));
