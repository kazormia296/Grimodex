import { electronBridge, isElectron } from "./shell";
import { isTauri } from "./tauri";

/**
 * 現在ウィンドウ操作の抽象層（@tauri-apps/api/window の中央ラッパー）。
 * 現に使われている操作（minimize / toggleMaximize / close / isMaximized /
 * fullscreen / onResized / onCloseRequested）のみラップする。
 *
 * Electron シェルでは preload の windowControls ブリッジ
 * （window.grimodex.windowControls）を経由する（設計書 §6.3 / §6.4）。
 * それ以外の非 Tauri 環境では従来（getCurrentWindow() が throw）と同じく
 * reject する。呼び出し側は isTauri() ガード（WindowControls.tsx）か
 * catch（App.tsx）済み。
 */

/** onCloseRequested ハンドラが受け取るイベント。preventDefault で close を veto する。 */
export interface WindowCloseRequestedEvent {
  preventDefault(): void;
}

async function currentWindow() {
  if (!isTauri()) {
    throw new Error(
      "window controls are unavailable outside the Tauri runtime",
    );
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** Electron シェル時のみ bridge の windowControls（isTauri 優先の分岐順 — §3.4）。 */
function electronWindowControls() {
  if (!isTauri() && isElectron()) {
    return electronBridge().windowControls;
  }
  return null;
}

export async function minimizeWindow(): Promise<void> {
  const electron = electronWindowControls();
  if (electron) return electron.minimize();
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  const electron = electronWindowControls();
  if (electron) return electron.toggleMaximize();
  await (await currentWindow()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  const electron = electronWindowControls();
  if (electron) return electron.close();
  await (await currentWindow()).close();
}

export async function isWindowMaximized(): Promise<boolean> {
  const electron = electronWindowControls();
  if (electron) return electron.isMaximized();
  return (await currentWindow()).isMaximized();
}

/**
 * 現在ウィンドウの native fullscreen を切り替え、確定した次状態を返す。
 * Electron/Tauri 以外（Web Editor）では標準 Fullscreen API にフォールバックする。
 */
export async function toggleFullscreenWindow(): Promise<boolean> {
  const electron = electronWindowControls();
  if (electron) return electron.toggleFullscreen();
  if (isTauri()) {
    const win = await currentWindow();
    const next = !(await win.isFullscreen());
    await win.setFullscreen(next);
    return next;
  }
  if (typeof document === "undefined") {
    throw new Error("fullscreen is unavailable without a document");
  }
  if (document.fullscreenElement) {
    if (!document.exitFullscreen) {
      throw new Error("document.exitFullscreen is unavailable");
    }
    await document.exitFullscreen();
  } else {
    const request = document.documentElement.requestFullscreen;
    if (!request) {
      throw new Error("Element.requestFullscreen is unavailable");
    }
    await request.call(document.documentElement);
  }
  return Boolean(document.fullscreenElement);
}

/** Native/Web の現在 fullscreen 状態を同じ契約で読む。 */
export async function isWindowFullscreen(): Promise<boolean> {
  const electron = electronWindowControls();
  if (electron) return electron.isFullscreen();
  if (isTauri()) return (await currentWindow()).isFullscreen();
  return typeof document !== "undefined" && Boolean(document.fullscreenElement);
}

/** ウィンドウのリサイズを購読する。戻り値は解除関数。 */
export async function onWindowResized(
  handler: () => void,
): Promise<() => void> {
  const electron = electronWindowControls();
  if (electron) return electron.onResized(handler);
  return (await currentWindow()).onResized(() => {
    handler();
  });
}

/**
 * close 要求を購読する（OS / ネイティブタイトルバー / カスタム閉じるボタンの
 * すべてを捕捉）。戻り値は解除関数。
 *
 * Electron では preventDefault() 呼び出しを `veto=true` の同期返答へ翻訳する
 * （main 側の非同期問い合わせプロトコルへの写像 — 設計書 §6.4）。
 */
export async function onWindowCloseRequested(
  handler: (event: WindowCloseRequestedEvent) => void,
): Promise<() => void> {
  const electron = electronWindowControls();
  if (electron) {
    return electron.onCloseRequested(() => {
      let veto = false;
      handler({
        preventDefault: () => {
          veto = true;
        },
      });
      return veto;
    });
  }
  return (await currentWindow()).onCloseRequested((event) => {
    handler(event);
  });
}
