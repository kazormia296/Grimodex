import { electronBridge, isElectron } from "./shell";
import { isTauri } from "./tauri";

/**
 * OS デフォルトブラウザで URL を開く抽象層（@tauri-apps/plugin-opener の
 * 中央ラッパー）。スキーム検証付きで開きたい場合は safeUrl.ts の
 * `openExternalUrl` を使うこと（本モジュールは検証しない。Electron シェルは
 * main 側でも scheme allowlist を再検証する二重防御 — 設計書 §3.4）。
 *
 * それ以外の非 Tauri 環境では従来（plugin 直呼び）と同じく reject する。
 */
export async function openUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl: tauriOpenUrl } = await import("@tauri-apps/plugin-opener");
    await tauriOpenUrl(url);
    return;
  }
  if (isElectron()) {
    await electronBridge().openExternal(url);
    return;
  }
  throw new Error("opener is unavailable outside the Tauri runtime");
}
