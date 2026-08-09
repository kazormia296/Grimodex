import { electronBridge, isElectron } from "./shell";
import { isTauri } from "./tauri";

/**
 * マルチウィンドウ（別窓生成・label 検索）の抽象層
 * （@tauri-apps/api/webviewWindow の中央ラッパー）。
 * 現に使われている操作（getByLabel / 生成 / setFocus）のみ公開する。
 *
 * Electron シェルでは main の panelWindow ブリッジへ写像する（設計書 §6.5。
 * main 側実体は electron/main/windows.ts の open/focus/existence APIs）。
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

/** label で既存窓を探す。無ければ null。非 Tauri / 非 Electron は null。 */
export async function getWebviewWindowByLabel(
  label: string,
): Promise<AppWindowHandle | null> {
  if (isTauri()) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return WebviewWindow.getByLabel(label);
  }
  if (isElectron()) {
    const bridge = electronBridge();
    const found = bridge.panelWindow.existsByLabel
      ? await bridge.panelWindow.existsByLabel(label)
      : await bridge.panelWindow.focusByLabel(label);
    if (!found) return null;
    return {
      async setFocus() {
        await bridge.panelWindow.focusByLabel(label);
      },
    };
  }
  return null;
}

/**
 * 新しい webview 窓を生成する。Tauri では生成失敗は WebviewWindow の契約通り
 * `tauri://error` イベントへ流れる（reject しない）。Electron では
 * `panelWindow.open` が reject しうる（既知の意味差 — §6.5。呼び出し元
 * `openPanelWindow` は await + 無通知許容なので影響なし）。
 * URL / transparent / decorations は main が label から組み立てるため
 * 渡さない（renderer 供給 URL を受け取らない侵害時ガード）。
 * 非 Tauri / 非 Electron は no-op。
 */
export async function createWebviewWindow(
  label: string,
  options: WebviewWindowOptions,
): Promise<void> {
  if (isTauri()) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    new WebviewWindow(label, options);
    return;
  }
  if (isElectron()) {
    await electronBridge().panelWindow.open(label, {
      width: options.width,
      height: options.height,
      title: options.title,
    });
  }
}
