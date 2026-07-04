// ────────────────────────────────────────────────────────────────────
// Vivliostyle 設定（settingsStore 経由の読み書き）。
// - vivliostyle.binaryPath: global（ユーザー環境依存）
// - vivliostyle.theme / vivliostyle.format: project（作品の体裁）
// ────────────────────────────────────────────────────────────────────

import { useSettingsStore } from "@/features/settings/settingsStore";
import { VIVLIOSTYLE_THEME_IDS } from "./themes";
import type { VivliostyleThemeId } from "./themes";
import type { VivliostyleFormat } from "./types";

export function useVivliostyleSettings() {
  const settingsStore = useSettingsStore();

  // 保存値が壊れていても UI が死なないよう既定へフォールバックする
  const storedTheme = settingsStore.get("vivliostyle.theme");
  const theme: VivliostyleThemeId = VIVLIOSTYLE_THEME_IDS.includes(
    storedTheme as VivliostyleThemeId,
  )
    ? (storedTheme as VivliostyleThemeId)
    : "bunko-vertical";
  const format: VivliostyleFormat =
    settingsStore.get("vivliostyle.format") === "epub" ? "epub" : "pdf";
  const binaryPath = settingsStore.get("vivliostyle.binaryPath");

  return {
    theme,
    format,
    binaryPath,
    setTheme: (id: VivliostyleThemeId) =>
      settingsStore.set("vivliostyle.theme", id),
    setFormat: (f: VivliostyleFormat) =>
      settingsStore.set("vivliostyle.format", f),
    setBinaryPath: (path: string) =>
      settingsStore.set("vivliostyle.binaryPath", path),
    /** 縦中横 policy は執筆側 editor.tateChuYoko 設定を流用する。 */
    tateChuYokoPolicy: settingsStore.get("editor.tateChuYoko", "2"),
  };
}
