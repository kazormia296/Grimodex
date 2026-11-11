import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * OS かアプリの設定で動きを減らす指定があるか。gsap を読まずに判定だけ使えるよう、
 * gsap.ts から分けてある（起動時に読む module は、こちらを直接 import する）。
 */
export function isReducedMotion(): boolean {
  const osReduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const appReduced = useSettingsStore
    .getState()
    .getBoolean("display.reduceMotion", false);
  return osReduced || appReduced;
}
