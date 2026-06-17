import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  createTateChuYokoPlugin,
  tateChuYokoKey,
  type TateChuYokoPolicy,
} from "./TateChuYokoPlugin";

/**
 * 縦書きモード時のみ縦中横プラグインを動的登録する。横書きでは登録せず（CSS も
 * `.editor-vertical` スコープなので二重ガード）、無駄な decoration 構築を避ける。
 *
 * policy（off/2/all）が変わると deps が変化して再登録され、plugin の state.init で
 * decoration を作り直す。useCodexHighlight と同じ registerPlugin/unregisterPlugin
 * ライフサイクル。
 */
export function useTateChuYoko(editor: Editor | null): void {
  const verticalMode = useSettingsStore((s) =>
    s.getBoolean("editor.verticalMode", false),
  );
  const policy = useSettingsStore((s) =>
    s.get("editor.tateChuYoko", "2"),
  ) as TateChuYokoPolicy;
  const active = verticalMode && policy !== "off";

  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.view?.state) return;
    if (!active) return;
    const existing = editor.view.state.plugins.find(
      (p) => p.spec.key === tateChuYokoKey,
    );
    if (!existing) {
      editor.registerPlugin(createTateChuYokoPlugin(policy));
    }
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(tateChuYokoKey);
    };
  }, [editor, active, policy]);
}
