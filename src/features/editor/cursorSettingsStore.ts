import { create } from "zustand";
import { useSettingsStore } from "@/features/settings/settingsStore";

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
    set((s) => {
      const next = !s.cursorAnimation;
      useSettingsStore.getState().set("editor.smoothCaret", String(next));
      return { cursorAnimation: next };
    }),

  focusMode: false,
  toggleFocusMode: () =>
    set((s) => {
      const next = !s.focusMode;
      useSettingsStore.getState().set("editor.typewriterMode", String(next));
      return { focusMode: next };
    }),

  showComments: false,
  toggleShowComments: () => set((s) => ({ showComments: !s.showComments })),
}));
