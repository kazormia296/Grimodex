import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { focusModeKey, createFocusModePlugin } from "./FocusModePlugin";

export function useFocusMode(editor: Editor | null) {
  const focusMode = useCursorSettingsStore((s) => s.focusMode);

  // Register plugin once
  useEffect(() => {
    if (!editor) return;
    const existing = editor.view.state.plugins.find(
      (p) => p.spec.key === focusModeKey,
    );
    if (!existing) {
      editor.registerPlugin(
        createFocusModePlugin(
          () => useCursorSettingsStore.getState().focusMode,
        ),
      );
    }
    return () => {
      editor.unregisterPlugin(focusModeKey);
    };
  }, [editor]);

  // Force recalculation when focusMode toggle changes
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    tr.setMeta("focusModeUpdate", true);
    editor.view.dispatch(tr);
  }, [editor, focusMode]);
}
