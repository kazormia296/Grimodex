import { isTauri } from "./tauri";

/**
 * OS デフォルトブラウザで URL を開く抽象層（@tauri-apps/plugin-opener の
 * 中央ラッパー）。スキーム検証付きで開きたい場合は safeUrl.ts の
 * `openExternalUrl` を使うこと（本モジュールは検証しない）。
 *
 * 非 Tauri 環境では従来（plugin 直呼び）と同じく reject する。
 */
export async function openUrl(url: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("opener is unavailable outside the Tauri runtime");
  }
  const { openUrl: tauriOpenUrl } = await import("@tauri-apps/plugin-opener");
  await tauriOpenUrl(url);
}
