import type { Editor } from "@tiptap/core";
import { useEditorStore } from "./editorStore";

/** Read the live editor instance without exposing the Editor Zustand store. */
export function getActiveEditor(): Editor | null {
  return useEditorStore.getState().editor;
}
