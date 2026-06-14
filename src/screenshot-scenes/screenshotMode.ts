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

/** 撮影ステージのシード／デモ言語。UI 言語（global-settings.uiLanguage）と揃える。 */
export type ScreenshotLanguage = "ja" | "en";

/** サポートする撮影言語の一覧（CLI/env 検証や filename 生成にも使う）。 */
export const SCREENSHOT_LANGUAGES: readonly ScreenshotLanguage[] = ["ja", "en"];

/** 撮影シードの既定言語（capture manifest / 出力名のデフォルトと揃える）。 */
export const DEFAULT_SCREENSHOT_LANGUAGE: ScreenshotLanguage = "ja";

export const SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY =
  "grimodex:screenshot-language";

/**
 * 撮影ステージのコンテンツ言語。`capture-screenshots.ts` の init が
 * localStorage にセットし、browser-mock のシードと screenshotBootstrap の
 * デモ状態が同じキーを参照する。未設定／不正値は既定（ja）。
 */
export function getScreenshotLanguage(): ScreenshotLanguage {
  if (typeof localStorage === "undefined") return DEFAULT_SCREENSHOT_LANGUAGE;
  try {
    const raw = localStorage.getItem(SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY);
    return raw === "en" ? "en" : DEFAULT_SCREENSHOT_LANGUAGE;
  } catch {
    return DEFAULT_SCREENSHOT_LANGUAGE;
  }
}
