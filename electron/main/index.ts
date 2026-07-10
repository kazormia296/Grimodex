/**
 * Electron main プロセスのエントリポイント（Phase 2 S3 骨格）。
 *
 * - app ライフサイクル管理 + 単一インスタンスロック
 * - ipc ルーター / イベントバス / napi Backend の接続は S4 以降で行う
 *   （設計書 docs/Grimodex_Electron移行Phase2設計書.md §3.1 / §8 S3）
 */
import { app } from "electron";

import { createMainWindow, getWindow } from "./windows.js";
import {
  applySessionPermissionPolicy,
  registerSecurityHandlers,
} from "./security.js";

// Phase 2 は既存 Tauri の app_data_dir (com.miyakey.grimodex) に触らない（§6.8）。
// userData は ~/.config/GrimodexElectronDev 相当に隔離される。
app.setName("GrimodexElectronDev");

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const main = getWindow("main");
    if (!main) return;
    if (main.isMinimized()) main.restore();
    main.focus();
  });

  registerSecurityHandlers(app);

  void app.whenReady().then(() => {
    applySessionPermissionPolicy();
    createMainWindow();
  });

  // 単一アプリ窓の現行挙動に合わせ、macOS 含め全窓クローズで終了する（§6.5）。
  app.on("window-all-closed", () => {
    app.quit();
  });
}
