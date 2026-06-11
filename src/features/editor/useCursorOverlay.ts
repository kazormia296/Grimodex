import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  cursorOverlayKey,
  createCursorOverlayPlugin,
} from "./CursorOverlayPlugin";

/**
 * Registers the cursor overlay ProseMirror plugin for the given editor.
 * Reads `editor.smoothCaret` (custom-cursor enable) and `editor.cursorBlink`
 * (blink animation) directly from the settings store so changes from any
 * surface (Settings UI, programmatic toggle) propagate immediately.
 * Mirrors the useFocusMode pattern: plugin is registered once on mount and
 * a meta transaction is dispatched whenever the toggle changes to force an
 * update cycle.
 */
export function useCursorOverlay(editor: Editor | null) {
  const cursorAnimation = useSettingsStore((s) =>
    s.getBoolean("editor.smoothCaret", true),
  );
  const cursorBlink = useSettingsStore((s) =>
    s.getBoolean("editor.cursorBlink", true),
  );
  // Writing mode は plugin 内で call-time 読み (getVertical)。縦書きでは
  // キャレットを横棒で描き、行跨ぎ affinity を X 軸で解決する。モード切替は
  // 下の effect の meta dispatch で再描画される。
  const verticalMode = useSettingsStore((s) =>
    s.getBoolean("editor.verticalMode", false),
  );

  // Register plugin once per editor instance
  useEffect(() => {
    if (!editor) return;
    editor.registerPlugin(
      createCursorOverlayPlugin(
        () =>
          useSettingsStore.getState().getBoolean("editor.smoothCaret", true),
        () =>
          useSettingsStore.getState().getBoolean("editor.cursorBlink", true),
        () =>
          useSettingsStore.getState().getBoolean("editor.verticalMode", false),
      ),
    );
    return () => {
      editor.unregisterPlugin(cursorOverlayKey);
    };
  }, [editor]);

  // Force update cycle when any toggle changes
  useEffect(() => {
    if (!isEditorViewReady(editor)) return;
    const { tr } = editor.state;
    tr.setMeta(cursorOverlayKey, true);
    editor.view.dispatch(tr);
  }, [editor, cursorAnimation, cursorBlink, verticalMode]);
}
