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
  /** Whether the "add comment" input popover is open. */
  commentPickerOpen: boolean;
  setCommentPickerOpen: (open: boolean) => void;
  /** Whether the foreshadow mark picker is open. */
  foreshadowPickerOpen: boolean;
  setForeshadowPickerOpen: (open: boolean) => void;
  /** Sync runtime state from persisted settings (call after loadAll). */
  initFromSettings: () => void;
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

  commentPickerOpen: false,
  setCommentPickerOpen: (open) => set({ commentPickerOpen: open }),

  foreshadowPickerOpen: false,
  setForeshadowPickerOpen: (open) => set({ foreshadowPickerOpen: open }),

  initFromSettings: () => {
    const s = useSettingsStore.getState();
    set({
      cursorAnimation: s.getBoolean("editor.smoothCaret", true),
      focusMode: s.getBoolean("editor.focusMode", false),
      typewriterMode: s.getBoolean("editor.typewriterMode", false),
    });
  },
}));
