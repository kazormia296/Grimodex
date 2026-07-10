import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "./tauri";

/**
 * 自動更新（updater / process）の抽象層。本体コードは
 * @tauri-apps/plugin-updater / plugin-process を直接 import せず
 * ここを経由する。store 遷移などの意味論は features/updater/api.ts が担う。
 */

export type { Update, DownloadEvent } from "@tauri-apps/plugin-updater";

/** 更新確認。非 Tauri は null（=更新なし）。 */
export async function check(): Promise<Update | null> {
  if (!isTauri()) return null;
  const { check: tauriCheck } = await import("@tauri-apps/plugin-updater");
  return tauriCheck();
}

/** アプリ再起動。非 Tauri は no-op。 */
export async function relaunch(): Promise<void> {
  if (!isTauri()) return;
  const { relaunch: tauriRelaunch } =
    await import("@tauri-apps/plugin-process");
  await tauriRelaunch();
}
