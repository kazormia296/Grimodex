import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { isEditorViewReady } from "./isEditorViewReady";

/**
 * Tracks whether the TipTap editor view is mounted. Required before accessing
 * `editor.view.dom` or `editor.view.dispatch` — especially when `useEditor`
 * recreates the instance (e.g. switching file-backed ↔ DB-native extensions).
 */
export function useEditorViewReady(editor: Editor | null): boolean {
  const [ready, setReady] = useState(() => isEditorViewReady(editor));
  const trackedEditor = useRef(editor);

  useEffect(() => {
    trackedEditor.current = editor;
    if (!editor) {
      setReady(false);
      return;
    }

    setReady(isEditorViewReady(editor));

    const onCreate = () => setReady(true);
    const onDestroy = () => setReady(false);
    editor.on("create", onCreate);
    editor.on("destroy", onDestroy);
    return () => {
      editor.off("create", onCreate);
      editor.off("destroy", onDestroy);
    };
  }, [editor]);

  // useEditor may swap the instance between renders; the previous ready flag is
  // stale until the effect above re-runs — probe synchronously in that window.
  if (trackedEditor.current !== editor) {
    return isEditorViewReady(editor);
  }

  return ready;
}
