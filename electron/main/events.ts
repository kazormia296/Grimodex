/**
 * EventBus（設計書 §7.1、Phase 2 S4 は骨格 — 実運用検証と TSFn 配線は S7）。
 *
 * - renderer 発 emit: `ipcRenderer.send("grim:emit")` → main が allowlist
 *   検証（列挙制、§5.4）→ **全窓に broadcast（送信元窓を含む）**。
 *   Tauri v2 の emit 契約（全窓配信 + 自己配信）と一致させる —
 *   codexWindowSync.ts のロック収束と external_mount 契約が依存する性質。
 * - napi ThreadsafeFunction 発（backend.onEvent → broadcastEvent）の配線は
 *   S7 で `backend:ready` / `workspace:opened` により end-to-end 実証する。
 */
import { BrowserWindow, ipcMain } from "electron";

import { IPC, isAllowedEventChannel } from "../shared/ipcContract.js";

/** 全窓（送信元含む）へ 1 イベントを配信する。 */
export function broadcastEvent(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC.event, channel, payload);
  }
}

/** app ready 後に 1 回だけ呼ぶ。 */
export function registerEventBus(): void {
  ipcMain.on(IPC.emit, (_event, channel: unknown, payload: unknown) => {
    if (typeof channel !== "string" || !isAllowedEventChannel(channel)) {
      console.warn(
        `[grim:emit] rejected non-allowlisted channel: ${String(channel)}`,
      );
      return;
    }
    broadcastEvent(channel, payload);
  });
}
