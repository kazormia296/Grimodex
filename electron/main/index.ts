/**
 * Electron main プロセスのエントリポイント。
 *
 * - app ライフサイクル管理 + 単一インスタンスロック（S3）
 * - napi Backend ロード → invoke ルーター → イベントバスの接続（S4）
 * - 本番ロード: app:// スキーム登録 + dist/ 配信（S8）
 *   （設計書 docs/Grimodex_Electron移行Phase2設計書.md §2 / §8 S4 / S8）
 */
import path from "node:path";

import { app, dialog, safeStorage } from "electron";

import { initBackend } from "./backend.js";
import { createCliAiManager } from "./cliAi.js";
import { migrateLegacyKeyringToSafeStorage } from "./credentialMigration.js";
import { registerEventBus, broadcastEvent } from "./events.js";
import { createExternalMountManager } from "./externalMount.js";
import { registerIpcRouter } from "./ipc.js";
import { buildKeyStoreShellHandlers, createKeyStore } from "./keyStore.js";
import { createLicenseValidationScheduler } from "./licenseValidation.js";
import {
  buildMcpConfigShellHandlers,
  prepareMcpSidecarForStartup,
  resolveMcpSidecarPath,
} from "./mcpSidecar.js";
import {
  registerAppProtocolHandler,
  registerAppProtocolScheme,
} from "./protocol.js";
import { showSavePathDialog } from "./shellCommands.js";
import { configureAppUserData } from "./userData.js";
import {
  createElectronUpdaterManager,
  resolveElectronUpdaterAvailability,
} from "./updater.js";
import { createVivliostyleManager } from "./vivliostyle.js";
import { createMainWindow, getWindow } from "./windows.js";
import {
  applySessionPermissionPolicy,
  registerSecurityHandlers,
} from "./security.js";

// Phase 4: packaged版は既存Tauriのdata_dirをそのまま正本にし、dev版は
// GrimodexElectronDevへ隔離する。スモークの絶対overrideもここで処理する。
// 単一instance lock / native backend / window-state / credential / MCPが同じpathを
// 観測するよう、readyとrequestSingleInstanceLockより前に作成まで完了させる。
const configuredUserDataDir = configureAppUserData(app);

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

  void app.whenReady().then(async () => {
    applySessionPermissionPolicy();
    // 本番ロード（§8 S8）: vite build 成果物 dist/ を app://bundle/ で配信。
    // main.cjs は <repo>/dist-electron/ に出るため dist は 1 つ上の隣。
    if (!process.env.ELECTRON_RENDERER_URL) {
      registerAppProtocolHandler(path.join(__dirname, "..", "dist"));
    }
    // .node ロード失敗は fail-soft（backend=null → 明示エラー envelope）
    const backend = initBackend();
    // Phase 4: final Tauri releaseのOS keyringかsafeStorageへ、1回だけ
    // copyする。旧keyringはrollback用に残し、plaintextはmainから出さない。
    // 全キーの暗号化・復号検証が成功するまでmarker/暗号文を確定しない。
    const keyStore = createKeyStore(configuredUserDataDir, safeStorage);
    try {
      const migration = await migrateLegacyKeyringToSafeStorage(
        backend,
        keyStore,
        configuredUserDataDir,
      );
      if (migration.status === "migrated") {
        console.log(
          `[grimodex-electron] legacy keyring migration complete: imported=${migration.imported} skipped=${migration.skippedExisting}`,
        );
      } else if (migration.status === "unavailable" && app.isPackaged) {
        throw new Error(
          "The packaged native backend does not include legacy-keyring-migration",
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[grimodex-electron] legacy keyring migration failed: ${detail}`,
      );
      await dialog.showMessageBox({
        type: "warning",
        title: "APIキーの移行を完了できませんでした",
        message:
          "旧版のAPIキーは削除されていません。必要な場合は設定画面で再入力してください。",
        detail,
        buttons: ["OK"],
        defaultId: 0,
        noLink: true,
      });
    }
    // Packaged Linux copies the MCP binary out of a transient AppImage mount.
    // Do this on every app startup so an already-copied `.mcp.json` receives
    // the current sidecar without requiring the user to open Settings again.
    let resolveMcpSidecar = () => resolveMcpSidecarPath();
    try {
      resolveMcpSidecar = await prepareMcpSidecarForStartup(
        app.isPackaged,
        resolveMcpSidecar,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[grimodex-electron] MCP sidecar startup preparation failed: ${detail}`,
      );
      await dialog.showMessageBox({
        type: "warning",
        title: "MCP連携を更新できませんでした",
        message:
          "Grimodex本体は起動できますが、MCP連携は設定画面で再試行してください。",
        detail,
        buttons: ["OK"],
        defaultId: 0,
        noLink: true,
      });
    }
    // external_mount（§2 バッチ2）: registry + chokidar watcher を持つ常駐
    // マネージャを 1 個生成し、その shell コマンドハンドラを invoke ルーターへ
    // 注入する。watcher イベントは broadcastEvent で全窓へ配信（external-mount://
    // の全窓 broadcast 契約）。
    const externalMount = createExternalMountManager(broadcastEvent);
    // CLI AI（バッチ3c）: active child / abort / process-tree kill を invoke を跨いで
    // 共有する単一 manager。イベントは固定 cli:stream-* を全窓へ配信する。
    const cliAi = createCliAiManager(broadcastEvent, {
      // 自動検出外のpathはrendererの文字列だけでは信頼しない。ユーザーがpathを
      // 見た上でnative dialogを明示許可した場合だけ、session allowlistへ入れる。
      authorizeExecutable: async (kind, executable) => {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          title: "CLI実行の確認",
          message: `${kind} CLIを実行しますか？`,
          detail: [
            "Grimodexが次の実行ファイルを起動し、入力したプロンプトを渡します。",
            "自分で設定した信頼できるCLIであることを確認してください。",
            "",
            executable,
          ].join("\n"),
          buttons: ["許可", "キャンセル"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return response === 0;
      },
    });
    // Vivliostyle（バッチ5）: build/preview child、成果物token、tempをmain lifetime
    // で共有する。custom pathはnative確認を通したvivliostyle名だけを許可し、
    // 保存先はrendererから受けずnative dialogで選ぶ。
    const vivliostyle = createVivliostyleManager(broadcastEvent, {
      authorizeExecutable: async (executable) => {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          title: "Vivliostyle CLI実行の確認",
          message: "Vivliostyle CLIを実行しますか？",
          detail: [
            "Grimodexが次の実行ファイルを起動し、本の組版・プレビューを行います。",
            "自分で設定した信頼できるCLIであることを確認してください。",
            "",
            executable,
          ].join("\n"),
          buttons: ["許可", "キャンセル"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return response === 0;
      },
      pickSavePath: (options) =>
        showSavePathDialog(getWindow("main") ?? null, options),
    });
    const updaterAvailability = resolveElectronUpdaterAvailability();
    if (app.isPackaged && !updaterAvailability.enabled) {
      console.log(`[grimodex-electron] ${updaterAvailability.reason}`);
    }
    const updater = createElectronUpdaterManager(broadcastEvent, {
      availability: updaterAvailability,
    });
    const licenseValidation = createLicenseValidationScheduler(
      backend,
      broadcastEvent,
    );
    licenseValidation.start();
    app.on("will-quit", () => {
      // close veto を通過して終了が確定してから同期 KILL する。before-quit で
      // dispose すると、未保存確認で終了を取り消した後も全 handler が死ぬ。
      vivliostyle.disposeAll();
      updater.dispose();
      licenseValidation.dispose();
      cliAi.disposeAll();
      void externalMount.disposeAll();
    });
    // API キー保管（バッチ3a）: safeStorage 暗号化 + ai-keys.json。has/save/delete は
    // shell ハンドラ、チャット送信のキー解決は dispatchInvoke へ secrets として注入。
    registerIpcRouter(
      backend,
      {
        ...externalMount.handlers,
        ...buildKeyStoreShellHandlers(keyStore),
        ...cliAi.handlers,
        ...vivliostyle.handlers,
        ...updater.handlers,
        ...buildMcpConfigShellHandlers(
          backend,
          path.join(configuredUserDataDir, "license.json"),
          resolveMcpSidecar,
        ),
      },
      keyStore,
      broadcastEvent,
    );
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
