import { electronBridge, isElectron } from "./shell";
import { isTauri } from "./tauri";

/**
 * アプリのバージョン取得の抽象層。本体コードは @tauri-apps/api/app を
 * 直接 import せずここを経由する。Electron シェルでは main の
 * `app.getVersion()` ブリッジへ写像する（設計書 §3.4）。
 *
 * それ以外の非 Tauri 環境では従来（plugin 直呼び）と同じく reject する。
 * 呼び出し側は全員 catch 済み（AppInfoHeader / fetchReleaseNotes）。
 */
export async function getVersion(): Promise<string> {
  if (isTauri()) {
    const { getVersion: tauriGetVersion } = await import("@tauri-apps/api/app");
    return tauriGetVersion();
  }
  if (isElectron()) {
    return electronBridge().getVersion();
  }
  throw new Error("app version is unavailable outside the Tauri runtime");
}
