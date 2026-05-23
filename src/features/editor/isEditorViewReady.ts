import type { Editor } from "@tiptap/core";

/** True when TipTap has mounted the ProseMirror view (safe to access `editor.view.dom`). */
export function isEditorViewReady(
  editor: Editor | null | undefined,
): editor is Editor {
  if (!editor || editor.isDestroyed) return false;
  try {
    void editor.view.dom;
    return true;
  } catch {
    return false;
  }
}
