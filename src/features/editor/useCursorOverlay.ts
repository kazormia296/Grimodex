import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  cursorOverlayKey,
  createCursorOverlayPlugin,
} from "./CursorOverlayPlugin";
import {
  CARET_SLIDE_DURATION_DEFAULT,
  CARET_SLIDE_SNAPPINESS_DEFAULT,
  applyCaretSlideVars,
  clampCaretSlideDuration,
} from "./caretSlideStyle";

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
  const slideDuration = useSettingsStore((s) =>
    s.getNumber("editor.caretSlideDuration", CARET_SLIDE_DURATION_DEFAULT),
  );
  const slideSnappiness = useSettingsStore((s) =>
    s.getNumber("editor.caretSlideSnappiness", CARET_SLIDE_SNAPPINESS_DEFAULT),
  );

  // スライドの duration/easing は CSS 変数経由 (:root)。エディタが複数あって
  // も冪等な同値書き込みなので、インスタンスごとに呼んで問題ない。
  useEffect(() => {
    applyCaretSlideVars(slideDuration, slideSnappiness);
  }, [slideDuration, slideSnappiness]);

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
        // 高速入力検出の閾値。実効スライド時間 (CSS 変数と同じクランプ値) を
        // 使うことで「スライドが追いつけない速さ」をそのまま基準にする。
        () =>
          clampCaretSlideDuration(
            useSettingsStore
              .getState()
              .getNumber(
                "editor.caretSlideDuration",
                CARET_SLIDE_DURATION_DEFAULT,
              ),
          ),
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
