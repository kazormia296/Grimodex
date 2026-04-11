import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import {
  cursorOverlayKey,
  createCursorOverlayPlugin,
} from "./CursorOverlayPlugin";

/**
 * Registers the cursor overlay ProseMirror plugin for the given editor.
 * Mirrors the useFocusMode pattern: plugin is registered once on mount and
 * a meta transaction is dispatched whenever the setting toggles to force an
 * update cycle.
 */
export function useCursorOverlay(editor: Editor | null) {
  const cursorAnimation = useCursorSettingsStore((s) => s.cursorAnimation);

  // Register plugin once per editor instance
  useEffect(() => {
    if (!editor) return;
    editor.registerPlugin(
      createCursorOverlayPlugin(
        () => useCursorSettingsStore.getState().cursorAnimation,
      ),
    );
    return () => {
      editor.unregisterPlugin(cursorOverlayKey);
    };
  }, [editor]);

  // Force update cycle when the toggle changes
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    tr.setMeta(cursorOverlayKey, true);
    editor.view.dispatch(tr);
  }, [editor, cursorAnimation]);
}
