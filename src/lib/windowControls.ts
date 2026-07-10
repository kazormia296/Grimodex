import { isTauri } from "./tauri";

/**
 * 現在ウィンドウ操作の抽象層（@tauri-apps/api/window の中央ラッパー）。
 * 現に使われている操作（minimize / toggleMaximize / close / isMaximized /
 * onResized / onCloseRequested）のみラップする。
 *
 * 非 Tauri 環境では従来（getCurrentWindow() が throw）と同じく reject する。
 * 呼び出し側は isTauri() ガード（WindowControls.tsx）か catch（App.tsx）済み。
 */

/** onCloseRequested ハンドラが受け取るイベント。preventDefault で close を veto する。 */
export interface WindowCloseRequestedEvent {
  preventDefault(): void;
}

async function currentWindow() {
  if (!isTauri()) {
    throw new Error("window controls are unavailable outside the Tauri runtime");
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  await (await currentWindow()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  await (await currentWindow()).close();
}

export async function isWindowMaximized(): Promise<boolean> {
  return (await currentWindow()).isMaximized();
}

/** ウィンドウのリサイズを購読する。戻り値は解除関数。 */
export async function onWindowResized(
  handler: () => void,
): Promise<() => void> {
  return (await currentWindow()).onResized(() => {
    handler();
  });
}

/**
 * close 要求を購読する（OS / ネイティブタイトルバー / カスタム閉じるボタンの
 * すべてを捕捉）。戻り値は解除関数。
 */
export async function onWindowCloseRequested(
  handler: (event: WindowCloseRequestedEvent) => void,
): Promise<() => void> {
  return (await currentWindow()).onCloseRequested((event) => {
    handler(event);
  });
}
