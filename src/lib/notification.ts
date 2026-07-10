import { isTauri } from "./tauri";

/**
 * デスクトップ (OS) 通知の抽象層（@tauri-apps/plugin-notification の
 * 中央ラッパー）。現に使われている 3 関数のみラップする。
 *
 * 非 Tauri 環境では Web Notification API にフォールバックする。
 * 旧実装（plugin 直呼び）も内部は素の window.Notification だったため、
 * ブラウザ実行（pnpm dev）で通知が動く従来挙動を維持する。
 */

export type NotificationPermission = "granted" | "denied" | "default";

export interface NotificationOptions {
  title: string;
  body?: string;
}

export async function isPermissionGranted(): Promise<boolean> {
  if (!isTauri()) {
    return "Notification" in window && Notification.permission === "granted";
  }
  const mod = await import("@tauri-apps/plugin-notification");
  return mod.isPermissionGranted();
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (!isTauri()) {
    // Notification 不在の環境（テスト等）は旧 plugin 実装と同じく throw に
    // なる（呼び出し側 desktopNotify.ts は best-effort 前提で catch 済み）。
    return Notification.requestPermission();
  }
  const mod = await import("@tauri-apps/plugin-notification");
  return mod.requestPermission();
}

export async function sendNotification(
  options: NotificationOptions,
): Promise<void> {
  if (!isTauri()) {
    new Notification(options.title, { body: options.body });
    return;
  }
  const mod = await import("@tauri-apps/plugin-notification");
  mod.sendNotification(options);
}
