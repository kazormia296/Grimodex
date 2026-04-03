import { create } from "zustand";

interface CursorSettingsState {
  cursorAnimation: boolean;
  toggleCursorAnimation: () => void;
  focusMode: boolean;
  toggleFocusMode: () => void;
  showComments: boolean;
  toggleShowComments: () => void;
}

export const useCursorSettingsStore = create<CursorSettingsState>()((set) => ({
  cursorAnimation: true,
  toggleCursorAnimation: () =>
    set((s) => ({ cursorAnimation: !s.cursorAnimation })),
  focusMode: false,
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  showComments: false,
  toggleShowComments: () => set((s) => ({ showComments: !s.showComments })),
}));
