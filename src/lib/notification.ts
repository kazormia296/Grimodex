import { isTauri } from "./tauri";

/**
 * デスクトップ (OS) 通知の抽象層（@tauri-apps/plugin-notification の
 * 中央ラッパー）。現に使われている 3 関数のみラップする。
 *
 * 非 Tauri 環境では従来（plugin 直呼び）と同じく reject する。
 * 呼び出し側（desktopNotify.ts）は best-effort 前提で catch 済み。
 */

export type NotificationPermission = "granted" | "denied" | "default";

export interface NotificationOptions {
  title: string;
  body?: string;
}

function assertTauri(): void {
  if (!isTauri()) {
    throw new Error("notification is unavailable outside the Tauri runtime");
  }
}

export async function isPermissionGranted(): Promise<boolean> {
  assertTauri();
  const mod = await import("@tauri-apps/plugin-notification");
  return mod.isPermissionGranted();
}

export async function requestPermission(): Promise<NotificationPermission> {
  assertTauri();
  const mod = await import("@tauri-apps/plugin-notification");
  return mod.requestPermission();
}

export async function sendNotification(
  options: NotificationOptions,
): Promise<void> {
  assertTauri();
  const mod = await import("@tauri-apps/plugin-notification");
  mod.sendNotification(options);
}
