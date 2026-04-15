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

  setFocusedEditor: (editor: Editor | null, sceneId: string | null) => void;
  setPendingScrollToId: (id: string | null) => void;
}

export const useLinearEditorStore = create<LinearEditorState>()((set) => ({
  focusedEditor: null,
  focusedSceneId: null,
  pendingScrollToId: null,

  setFocusedEditor(editor, sceneId) {
    set({ focusedEditor: editor, focusedSceneId: sceneId });
    // Keep global editorStore in sync for ChatPanel inserts
    useEditorStore.getState().setEditor(editor);
  },

  setPendingScrollToId(id) {
    set({ pendingScrollToId: id });
  },
}));
