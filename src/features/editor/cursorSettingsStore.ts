import { create } from "zustand";
import type { Editor } from "@tiptap/core";
import {
  readRuntimeSettingBoolean,
  writeRuntimeSetting,
} from "@/features/settings/runtimeSettings";
import type { LayerSetOptions } from "@/features/post-effect/types";

interface CursorSettingsState {
  cursorAnimation: boolean;
  toggleCursorAnimation: () => void;
  cursorBlink: boolean;
  toggleCursorBlink: () => void;
  focusMode: boolean;
  toggleFocusMode: () => void;
  typewriterMode: boolean;
  toggleTypewriterMode: () => void;
  zenMode: boolean;
  setZenMode: (active: boolean) => void;
  toggleZenMode: () => void;
  showComments: boolean;
  setShowComments: (visible: boolean, opts?: LayerSetOptions) => void;
  toggleShowComments: () => void;
  showForeshadowMarks: boolean;
  setShowForeshadowMarks: (visible: boolean, opts?: LayerSetOptions) => void;
  toggleShowForeshadowMarks: () => void;
  /** Lint 波線の表示（本文レイヤー）。診断の実行自体は止めない。 */
  showLint: boolean;
  setShowLint: (visible: boolean, opts?: LayerSetOptions) => void;
  toggleShowLint: () => void;
  /** 本文レイヤーのパネル連動 (Auto) モード。ON中は開いているパネルに追従。 */
  layerAutoFollow: boolean;
  toggleLayerAutoFollow: () => void;
  /**
   * パネル連動の再同期要求カウンタ（非永続）。initFromSettings 等の外部リセットが
   * Auto 追従中のランタイム状態を巻き戻した後に bump すると、useLayerAutoFollow の
   * follow effect が再実行されてパネル可視状態へ再同期する。
   */
  layerAutoFollowSyncNonce: number;
  requestLayerAutoFollowSync: () => void;
  /** Whether the "add comment" input popover is open. */
  commentPickerOpen: boolean;
  setCommentPickerOpen: (open: boolean) => void;
  /** Whether the Codex semantic-link entry picker is open. */
  semanticLinkPickerOpen: boolean;
  /** Editor that owns the semantic-link picker in split/linear views. */
  semanticLinkPickerOwner: Editor | null;
  setSemanticLinkPickerOpen: (open: boolean, owner?: Editor | null) => void;
  /** Whether the foreshadow mark picker is open. */
  foreshadowPickerOpen: boolean;
  setForeshadowPickerOpen: (open: boolean) => void;
  /** Mode to open the foreshadow picker in (null = show mode selector). */
  foreshadowPickerInitialMode: "setup" | "payoff" | "payoff-unanchored" | null;
  /** Open the foreshadow picker directly in the specified mode. */
  openForeshadowPicker: (
    mode: "setup" | "payoff" | "payoff-unanchored" | null,
  ) => void;
  /** Sync runtime state from persisted settings (call after loadAll). */
  initFromSettings: () => void;
}

export const useCursorSettingsStore = create<CursorSettingsState>()(
  (set, get) => ({
    cursorAnimation: true,
    toggleCursorAnimation: () =>
      set((s) => {
        const next = !s.cursorAnimation;
        writeRuntimeSetting("editor.smoothCaret", String(next));
        return { cursorAnimation: next };
      }),

    cursorBlink: true,
    toggleCursorBlink: () =>
      set((s) => {
        const next = !s.cursorBlink;
        writeRuntimeSetting("editor.cursorBlink", String(next));
        return { cursorBlink: next };
      }),

    focusMode: false,
    toggleFocusMode: () =>
      set((s) => {
        const next = !s.focusMode;
        writeRuntimeSetting("editor.focusMode", String(next));
        return { focusMode: next };
      }),

    typewriterMode: false,
    toggleTypewriterMode: () =>
      set((s) => {
        const next = !s.typewriterMode;
        writeRuntimeSetting("editor.typewriterMode", String(next));
        return { typewriterMode: next };
      }),

    zenMode: false,
    setZenMode: (active) => set({ zenMode: active }),
    toggleZenMode: () => set((s) => ({ zenMode: !s.zenMode })),

    showComments: false,
    setShowComments: (visible, opts) => {
      if (opts?.persist !== false) {
        writeRuntimeSetting("display.layerComments", String(visible));
      }
      set({ showComments: visible });
    },
    toggleShowComments: () => get().setShowComments(!get().showComments),

    showForeshadowMarks: false,
    setShowForeshadowMarks: (visible, opts) => {
      if (opts?.persist !== false) {
        writeRuntimeSetting("display.layerForeshadow", String(visible));
      }
      set({ showForeshadowMarks: visible });
    },
    toggleShowForeshadowMarks: () =>
      get().setShowForeshadowMarks(!get().showForeshadowMarks),

    showLint: true,
    setShowLint: (visible, opts) => {
      if (opts?.persist !== false) {
        writeRuntimeSetting("display.layerLint", String(visible));
      }
      set({ showLint: visible });
    },
    toggleShowLint: () => get().setShowLint(!get().showLint),

    layerAutoFollow: false,
    toggleLayerAutoFollow: () =>
      set((s) => {
        const next = !s.layerAutoFollow;
        writeRuntimeSetting("display.layerAutoFollow", String(next));
        return { layerAutoFollow: next };
      }),

    layerAutoFollowSyncNonce: 0,
    requestLayerAutoFollowSync: () =>
      set((s) => ({
        layerAutoFollowSyncNonce: s.layerAutoFollowSyncNonce + 1,
      })),

    commentPickerOpen: false,
    setCommentPickerOpen: (open) => set({ commentPickerOpen: open }),

    semanticLinkPickerOpen: false,
    semanticLinkPickerOwner: null,
    setSemanticLinkPickerOpen: (open, owner = null) =>
      set({
        semanticLinkPickerOpen: open,
        semanticLinkPickerOwner: open ? owner : null,
      }),

    foreshadowPickerOpen: false,
    setForeshadowPickerOpen: (open) =>
      set({ foreshadowPickerOpen: open, foreshadowPickerInitialMode: null }),

    foreshadowPickerInitialMode: null,
    openForeshadowPicker: (mode) =>
      set({ foreshadowPickerOpen: true, foreshadowPickerInitialMode: mode }),

    initFromSettings: () => {
      set({
        cursorAnimation: readRuntimeSettingBoolean("editor.smoothCaret", true),
        cursorBlink: readRuntimeSettingBoolean("editor.cursorBlink", true),
        focusMode: readRuntimeSettingBoolean("editor.focusMode", false),
        typewriterMode: readRuntimeSettingBoolean(
          "editor.typewriterMode",
          false,
        ),
        // Zen is a transient view projection. Never reopen an application
        // session with all navigation chrome hidden.
        zenMode: false,
        showComments: readRuntimeSettingBoolean("display.layerComments", false),
        showForeshadowMarks: readRuntimeSettingBoolean(
          "display.layerForeshadow",
          false,
        ),
        showLint: readRuntimeSettingBoolean("display.layerLint", true),
        layerAutoFollow: readRuntimeSettingBoolean(
          "display.layerAutoFollow",
          false,
        ),
      });
    },
  }),
);
