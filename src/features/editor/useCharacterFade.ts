import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  characterFadeKey,
  createCharacterFadePlugin,
} from "./CharacterFadePlugin";
import {
  characterFadeOutKey,
  createCharacterFadeOutPlugin,
} from "./CharacterFadeOutPlugin";

/**
 * Registers the character fade-in / fade-out ProseMirror plugins so newly
 * typed text fades from opacity 0 → 1 and single-char deletions leave a
 * ghost glyph fading from 1 → 0 at the deletion point. Reads the toggles
 * directly from the settings store so changes from the Settings UI take
 * effect without remounting the editor.
 */
export function useCharacterFade(editor: Editor | null) {
  const fadeIn = useSettingsStore((s) =>
    s.getBoolean("editor.characterFadeIn", false),
  );
  const fadeOut = useSettingsStore((s) =>
    s.getBoolean("editor.characterFadeOut", false),
  );

  useEffect(() => {
    if (!editor) return;
    editor.registerPlugin(
      createCharacterFadePlugin(() =>
        useSettingsStore.getState().getBoolean("editor.characterFadeIn", false),
      ),
    );
    editor.registerPlugin(
      createCharacterFadeOutPlugin(() =>
        useSettingsStore
          .getState()
          .getBoolean("editor.characterFadeOut", false),
      ),
    );
    return () => {
      editor.unregisterPlugin(characterFadeKey);
      editor.unregisterPlugin(characterFadeOutKey);
    };
  }, [editor]);

  // Force a re-render path so the plugin sees the toggle change immediately.
  useEffect(() => {
    if (!isEditorViewReady(editor)) return;
    const { tr } = editor.state;
    tr.setMeta(characterFadeKey, { type: "cleanup", now: Date.now() });
    editor.view.dispatch(tr);
  }, [editor, fadeIn]);

  useEffect(() => {
    if (!isEditorViewReady(editor)) return;
    const { tr } = editor.state;
    tr.setMeta(characterFadeOutKey, { type: "consumed" });
    editor.view.dispatch(tr);
  }, [editor, fadeOut]);
}
