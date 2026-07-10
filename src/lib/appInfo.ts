import { isTauri } from "./tauri";

/**
 * アプリのバージョン取得の抽象層。本体コードは @tauri-apps/api/app を
 * 直接 import せずここを経由する（Electron 移行時はこのファイルだけ差し替える）。
 *
 * 非 Tauri 環境では従来（plugin 直呼び）と同じく reject する。
 * 呼び出し側は全員 catch 済み（AppInfoHeader / fetchReleaseNotes）。
 */
export async function getVersion(): Promise<string> {
  if (!isTauri()) {
    throw new Error("app version is unavailable outside the Tauri runtime");
  }
  const { getVersion: tauriGetVersion } = await import("@tauri-apps/api/app");
  return tauriGetVersion();
}
