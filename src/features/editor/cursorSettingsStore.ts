import { create } from "zustand";
import { useSettingsStore } from "@/features/settings/settingsStore";

interface CursorSettingsState {
  cursorAnimation: boolean;
  toggleCursorAnimation: () => void;
  focusMode: boolean;
  toggleFocusMode: () => void;
  typewriterMode: boolean;
  toggleTypewriterMode: () => void;
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
      useSettingsStore.getState().set("editor.focusMode", String(next));
      return { focusMode: next };
    }),

  typewriterMode: false,
  toggleTypewriterMode: () =>
    set((s) => {
      const next = !s.typewriterMode;
      useSettingsStore.getState().set("editor.typewriterMode", String(next));
      return { typewriterMode: next };
    }),

  showComments: false,
  toggleShowComments: () => set((s) => ({ showComments: !s.showComments })),
}));
