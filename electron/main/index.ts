/**
 * Electron main プロセスのエントリポイント。
 *
 * - app ライフサイクル管理 + 単一インスタンスロック（S3）
 * - napi Backend ロード → invoke ルーター → イベントバスの接続（S4）
 * - 本番ロード: app:// スキーム登録 + dist/ 配信（S8）
 *   （設計書 docs/Grimodex_Electron移行Phase2設計書.md §2 / §8 S4 / S8）
 */
import path from "node:path";

import { app } from "electron";

import { initBackend } from "./backend.js";
import { registerEventBus, broadcastEvent } from "./events.js";
import { createExternalMountManager } from "./externalMount.js";
import { registerIpcRouter } from "./ipc.js";
import {
  registerAppProtocolHandler,
  registerAppProtocolScheme,
} from "./protocol.js";
import { createMainWindow, getWindow } from "./windows.js";
import {
  applySessionPermissionPolicy,
  registerSecurityHandlers,
} from "./security.js";

// Phase 2 は既存 Tauri の app_data_dir (com.miyakey.grimodex) に触らない（§6.8）。
// userData は ~/.config/GrimodexElectronDev 相当に隔離される。
app.setName("GrimodexElectronDev");

// スモーク / 検証用の userData 分離（S8。electron/scripts/smoke.mjs が
// 一時ディレクトリを注入する）。requestSingleInstanceLock も window-state も
// userData 配下を使うため、必ずロック取得より前に上書きする。
const userDataOverride = process.env.GRIMODEX_USER_DATA_DIR;
if (userDataOverride && path.isAbsolute(userDataOverride)) {
  app.setPath("userData", userDataOverride);
}

// app:// の standard スキーム特権は ready 前に 1 回だけ登録できる（§8 S8）。
// dev（ELECTRON_RENDERER_URL あり）でも登録自体は無害 — ハンドラは本番のみ。
registerAppProtocolScheme();

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
    // 本番ロード（§8 S8）: vite build 成果物 dist/ を app://bundle/ で配信。
    // main.cjs は <repo>/dist-electron/ に出るため dist は 1 つ上の隣。
    if (!process.env.ELECTRON_RENDERER_URL) {
      registerAppProtocolHandler(path.join(__dirname, "..", "dist"));
    }
    // .node ロード失敗は fail-soft（backend=null → 明示エラー envelope）
    const backend = initBackend();
    // external_mount（§2 バッチ2）: registry + chokidar watcher を持つ常駐
    // マネージャを 1 個生成し、その shell コマンドハンドラを invoke ルーターへ
    // 注入する。watcher イベントは broadcastEvent で全窓へ配信（external-mount://
    // の全窓 broadcast 契約）。
    const externalMount = createExternalMountManager(broadcastEvent);
    app.on("will-quit", () => {
      void externalMount.disposeAll();
    });
    registerIpcRouter(backend, externalMount.handlers);
    // TSFn 配線（backend.onEvent → 全窓 broadcast）を含む（§7.1、S7）。
    // 登録時に flush される backend:ready は窓生成前のため renderer には
    // 届かない（FE 購読者なしのデバッグチャネル — TSFn 実証は
    // workspace:opened が担う）。
    registerEventBus(backend);
    createMainWindow();
  });

  // 単一アプリ窓の現行挙動に合わせ、macOS 含め全窓クローズで終了する（§6.5）。
  app.on("window-all-closed", () => {
    app.quit();
  });
}
