/**
 * Grimodex スクリーンショット用 Playwright／LP ステージングのフラグ読み取り。
 * `capture-screenshots.ts` の init とアプリ側で同じキーを参照する。
 */
export const SCREENSHOT_MODE_LOCALSTORAGE_KEY = "grimodex:screenshot-mode";

/** `grimodex:screenshot-mode` がセットされているか（staging ビルド専用） */
export function isScreenshotStagingActive(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY) === "true";
  } catch {
    return false;
  }
}
