import { isTauri } from "./tauri";

/**
 * マルチウィンドウ（別窓生成・label 検索）の抽象層
 * （@tauri-apps/api/webviewWindow の中央ラッパー）。
 * 現に使われている操作（getByLabel / 生成 / setFocus）のみ公開する。
 */

/** 抽象層が公開する別窓ハンドル。現に使う操作（setFocus）だけを持つ。 */
export interface AppWindowHandle {
  setFocus(): Promise<void>;
}

export interface WebviewWindowOptions {
  url: string;
  transparent: boolean;
  decorations: boolean;
  width: number;
  height: number;
  title: string;
}

/** label で既存窓を探す。無ければ null。非 Tauri は null。 */
export async function getWebviewWindowByLabel(
  label: string,
): Promise<AppWindowHandle | null> {
  if (!isTauri()) return null;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return WebviewWindow.getByLabel(label);
}

/**
 * 新しい webview 窓を生成する。生成失敗は WebviewWindow の契約通り
 * `tauri://error` イベントへ流れる（reject しない）。非 Tauri は no-op。
 */
export async function createWebviewWindow(
  label: string,
  options: WebviewWindowOptions,
): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  new WebviewWindow(label, options);
}
