import { useEffect } from "react";

import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * 表示設定のうち、document root の CSS 変数・属性で効かせるものを同期する
 * （帰属ハイライトの濃さ、UI フォント、アプリ設定の「動きを減らす」）。
 */
export function useRootDisplaySettings(): void {
  const attributionOpacity = useSettingsStore((state) =>
    state.getNumber("display.attributionHighlightOpacity", 10),
  );
  const uiFontFamily = useSettingsStore((state) =>
    state.get("display.uiFontFamily"),
  );
  const appReduceMotion = useSettingsStore((state) =>
    state.getBoolean("display.reduceMotion", false),
  );

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--attribution-pct",
      `${attributionOpacity * 2}%`,
    );
  }, [attributionOpacity]);

  useEffect(() => {
    const html = document.documentElement;
    const value = uiFontFamily.trim();
    if (value) html.style.setProperty("--ui-font", value);
    else html.style.removeProperty("--ui-font");
  }, [uiFontFamily]);

  // index.css の reduced-motion の規則は OS の media query だけを見るので、
  // 同じ規則を root の属性でも効かせる（JS 側は useReducedMotion／
  // isReducedMotion が両方を見ている）。
  useEffect(() => {
    const html = document.documentElement;
    if (appReduceMotion) html.dataset.reduceMotion = "true";
    else delete html.dataset.reduceMotion;
  }, [appReduceMotion]);
}
