import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { isWebKitGtk } from "@/lib/platform";
import {
  createEmphasisDotsFallbackPlugin,
  emphasisDotsFallbackKey,
} from "./EmphasisDotsFallbackPlugin";

/**
 * WebKitGTK かつ縦書きモード時のみ傍点フォールバックプラグインを動的登録する。
 * Chromium/WKWebView と横書きでは native text-emphasis が正しく描くため登録せず
 * （CSS 側も html[data-engine="webkitgtk"] .editor-vertical スコープで二重ガード）、
 * 無駄な per-char decoration 構築を避ける。useTateChuYoko と同じ
 * registerPlugin/unregisterPlugin ライフサイクル。
 */
export function useEmphasisDotsFallback(editor: Editor | null): void {
  const verticalMode = useSettingsStore((s) =>
    s.getBoolean("editor.verticalMode", false),
  );
  const active = verticalMode && isWebKitGtk();

  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.view?.state) return;
    if (!active) return;
    const existing = editor.view.state.plugins.find(
      (p) => p.spec.key === emphasisDotsFallbackKey,
    );
    if (!existing) {
      editor.registerPlugin(createEmphasisDotsFallbackPlugin());
    }
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(emphasisDotsFallbackKey);
    };
  }, [editor, active]);
}
