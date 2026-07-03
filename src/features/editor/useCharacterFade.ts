import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  characterFadeOutKey,
  createCharacterFadeOutPlugin,
} from "./CharacterFadeOutPlugin";

/**
 * Registers the character fade-out ProseMirror plugin so single-char
 * deletions leave a ghost glyph fading from 1 → 0 at the deletion point.
 * Reads the toggle directly from the settings store so changes from the
 * Settings UI take effect without remounting the editor.
 */
export function useCharacterFade(editor: Editor | null) {
  const fadeOut = useSettingsStore((s) =>
    s.getBoolean("editor.characterFadeOut", false),
  );
  useEffect(() => {
    if (!editor) return;
    // Writing mode は plugin 内で call-time 読み (getVertical)。縦書きでは
    // resolveCoordsVertical で座標を取り ghost を縦向きに描く。
    editor.registerPlugin(
      createCharacterFadeOutPlugin(
        () =>
          useSettingsStore
            .getState()
            .getBoolean("editor.characterFadeOut", false),
        () =>
          useSettingsStore.getState().getBoolean("editor.verticalMode", false),
      ),
    );
    return () => {
      editor.unregisterPlugin(characterFadeOutKey);
    };
  }, [editor]);

  // Force a re-render path so the plugin sees the toggle change immediately.
  useEffect(() => {
    if (!isEditorViewReady(editor)) return;
    const { tr } = editor.state;
    tr.setMeta(characterFadeOutKey, { type: "consumed" });
    editor.view.dispatch(tr);
  }, [editor, fadeOut]);
}
