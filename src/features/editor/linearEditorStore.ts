import { create } from "zustand";
import type { Editor } from "@tiptap/core";
import { useEditorStore } from "./editorStore";

interface LinearEditorState {
  /** The TipTap editor instance that currently has focus. */
  focusedEditor: Editor | null;
  /** The scene ID whose editor currently has focus. */
  focusedSceneId: string | null;
  /** Set by external navigation (Scenes panel, tab click) to request scrolling. */
  pendingScrollToId: string | null;
  /**
   * マウント中の LinearSceneBlock の editor 一覧 (sceneId → Editor)。
   * Toolbar / SceneMetaPanel が「active シーンの editor」をフォーカス
   * (クリック) 無しで参照するための registry。focusedEditor はクリック
   * するまで null なので、これが無いとリニア入場直後にツールバーが消える。
   */
  editorsById: Record<string, Editor>;

  setFocusedEditor: (editor: Editor | null, sceneId: string | null) => void;
  setPendingScrollToId: (id: string | null) => void;
  registerEditor: (sceneId: string, editor: Editor) => void;
  unregisterEditor: (sceneId: string, editor: Editor) => void;
}

export const useLinearEditorStore = create<LinearEditorState>()((set) => ({
  focusedEditor: null,
  focusedSceneId: null,
  pendingScrollToId: null,
  editorsById: {},

  setFocusedEditor(editor, sceneId) {
    set({ focusedEditor: editor, focusedSceneId: sceneId });
    // Keep global editorStore in sync for ChatPanel inserts
    useEditorStore.getState().setEditor(editor);
  },

  setPendingScrollToId(id) {
    set({ pendingScrollToId: id });
  },

  registerEditor(sceneId, editor) {
    set((s) => ({ editorsById: { ...s.editorsById, [sceneId]: editor } }));
  },

  unregisterEditor(sceneId, editor) {
    set((s) => {
      // 同一シーンの新インスタンスが先に register していたら消さない
      // (remount 時の register→旧 unregister の順序競合ガード)
      if (s.editorsById[sceneId] !== editor) return s;
      const next = { ...s.editorsById };
      delete next[sceneId];
      return { editorsById: next };
    });
  },
}));
