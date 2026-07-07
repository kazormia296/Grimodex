import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  showInvisiblesKey,
  createShowInvisiblesPlugin,
} from "./ShowInvisiblesPlugin";

/**
 * `editor.showInvisibles` が ON のときだけ空白・改行可視化プラグインを
 * 登録する (`useTateChuYoko` と同型: 条件付き register/unregister)。
 *
 * 登録/解除は state.reconfigure を伴い decoration が即再描画されるため、
 * useCharacterFade のような meta 強制再描画は不要。両サーフェス
 * (EditorPane / LinearSceneBlock) から呼ぶ。
 */
export function useShowInvisibles(editor: Editor | null) {
  const show = useSettingsStore((s) =>
    s.getBoolean("editor.showInvisibles", false),
  );
  useEffect(() => {
    if (!editor || !show) return;
    editor.registerPlugin(createShowInvisiblesPlugin());
    return () => {
      try {
        editor.unregisterPlugin(showInvisiblesKey);
      } catch {
        // editor already destroyed — nothing to unregister
      }
    };
  }, [editor, show]);
}
