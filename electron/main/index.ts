/**
 * Electron main プロセスのエントリポイント。
 *
 * - app ライフサイクル管理 + 単一インスタンスロック（S3）
 * - napi Backend ロード → invoke ルーター → イベントバスの接続（S4）
 * - 本番ロード: app:// スキーム登録 + dist/ 配信（S8）
 *   （設計書 docs/Grimodex_Electron移行Phase2設計書.md §2 / §8 S4 / S8）
 */
import path from "node:path";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { app, dialog, safeStorage } from "electron";

import { getBackend, initBackend } from "./backend.js";
import { createCliAiManager } from "./cliAi.js";
import { createCodexAppServerManager } from "./codexAppServer/manager.js";
import { readPersistedCodexAppServerSettings } from "./codexAppServer/persistedSettings.js";
import { createRuntimeThreadBindingStore } from "./codexAppServer/threadBindingStore.js";
import { migrateLegacyKeyringToSafeStorage } from "./credentialMigration.js";
import {
  broadcastBackendEvent,
  broadcastMainEvent,
  registerEventBus,
  setBackendEventEgressGate,
  sendBackendEventToWindow,
  sendMainEventToWindow,
} from "./events.js";
import { createExternalMountManager } from "./externalMount.js";
import { registerImeShutdown } from "./imeShutdown.js";
import { registerIpcRouter } from "./ipc.js";
import { buildKeyStoreShellHandlers, createKeyStore } from "./keyStore.js";
import { createLicenseValidationScheduler } from "./licenseValidation.js";
import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";
import { bootstrapNarrativeMaintenance } from "./narrativeMaintenanceBootstrap.js";
import type { NarrativeMaintenanceTriggerCoordinator } from "./narrativeMaintenanceTriggers.js";
import { configureLinuxGraphics } from "./linuxGraphics.js";
import { createMozkeyInstallerManager } from "./mozkeyInstaller.js";
import {
  buildMcpConfigShellHandlers,
  prepareMcpSidecarForStartup,
  resolveMcpSidecarPath,
  scheduleMcpSidecarWarmup,
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
import { createProfileEgressGate } from "./profileEgress.js";
import {
  applySessionPermissionPolicy,
  registerSecurityHandlers,
  setExternalEgressGate,
} from "./security.js";
import { parseWebEditorHandoffProtocolRequest } from "./webEditorHandoffProtocol.js";
import {
  shouldUseProductJourneyAi,
  wrapBackendForProductJourneyAi,
} from "./productJourneyAi.js";
import {
  configureNarrativeMaintenanceCiSeam,
  createNarrativeMaintenanceCiHeldFreshnessWriter,
  shouldFailFastNarrativeMaintenanceCiLaunch,
  shouldDisableNarrativeFreshnessForLaunch,
  writeNarrativeMaintenanceCiReceipt,
  type NarrativeMaintenanceCiBackend,
  type NarrativeMaintenanceCiHeldFreshnessWriter,
} from "./narrativeMaintenanceCiSeam.js";

const WEB_EDITOR_HANDOFF_EVENT = "web-editor-handoff:requested";
const WEB_EDITOR_HANDOFF_PAYLOAD = {
  kind: "web-editor-handoff",
} as const;

// A deep link is only an instruction to display the desktop handoff importer.
// It deliberately carries neither a path nor manuscript data. Startup links can
// arrive before BrowserWindow exists (including macOS open-url), so retain one
// pending request until the main renderer has completed its first load.
let pendingWebEditorHandoff =
  parseWebEditorHandoffProtocolRequest(process.argv) !== null;
let mainRendererReady = false;

async function initializeNarrativeMaintenanceStartup(
  userDataDir: string,
): Promise<{
  initializedBackend: ReturnType<typeof initBackend>;
  profileEgress: Awaited<ReturnType<typeof createProfileEgressGate>>;
  narrativeMaintenanceCiSeam: Awaited<
    ReturnType<typeof configureNarrativeMaintenanceCiSeam>
  >;
  narrativeMaintenanceCiHeldFreshnessWriter: NarrativeMaintenanceCiHeldFreshnessWriter | null;
} | null> {
  const failFast = shouldFailFastNarrativeMaintenanceCiLaunch({
    isPackaged: app.isPackaged,
    env: process.env,
  });
  try {
    // Ordinary/packaged launches retain the backend's explicit fail-soft
    // envelope. The owner-gated CI acceptance launch must fail before a
    // renderer can appear when native startup is unavailable.
    const initializedBackend = initBackend({ failFast });
    // D2a is the first main/native boundary after backend construction. It
    // must complete before CI seams, workspace events, schedulers, or a
    // renderer can publish profile plaintext.
    const profileEgress = await createProfileEgressGate(initializedBackend);
    setBackendEventEgressGate(profileEgress);
    // The product-journey seam is deliberately configured at this one startup
    // point: after native initialization, before any scheduler can observe a
    // workspace event. Unauthorized launches return inactive without reading
    // or forwarding the test-only environment values.
    const narrativeMaintenanceCiSeam =
      await configureNarrativeMaintenanceCiSeam(
        initializedBackend as unknown as NarrativeMaintenanceCiBackend | null,
        {
          isPackaged: app.isPackaged,
          env: process.env,
        },
      );
    // The harness may accept a seam-controlled renderer only after native
    // configuration has acknowledged the exact launch. Production launches
    // are inactive and therefore intentionally write no receipt.
    await writeNarrativeMaintenanceCiReceipt(narrativeMaintenanceCiSeam, {
      isPackaged: app.isPackaged,
      userDataDir,
    });
    const narrativeMaintenanceCiHeldFreshnessWriter =
      createNarrativeMaintenanceCiHeldFreshnessWriter(
        narrativeMaintenanceCiSeam,
        {
          userDataDir,
        },
      );
    return {
      initializedBackend,
      profileEgress,
      narrativeMaintenanceCiSeam,
      narrativeMaintenanceCiHeldFreshnessWriter,
    };
  } catch (error) {
    if (!failFast) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `[grimodex-electron] CI product-journey startup failed: ${detail}`,
    );
    app.exit(1);
    return null;
  }
}

function flushPendingWebEditorHandoff(): void {
  if (!pendingWebEditorHandoff || !mainRendererReady) return;
  const main = getWindow("main");
  if (!main || main.isDestroyed()) return;
  pendingWebEditorHandoff = false;
  sendMainEventToWindow(
    main.webContents.id,
    WEB_EDITOR_HANDOFF_EVENT,
    WEB_EDITOR_HANDOFF_PAYLOAD,
  );
}

function acceptWebEditorHandoffProtocolRequest(
  argvOrUrl: string | readonly string[],
): boolean {
  if (!parseWebEditorHandoffProtocolRequest(argvOrUrl)) return false;
  pendingWebEditorHandoff = true;
  flushPendingWebEditorHandoff();
  return true;
}

// Chromium の GPU process 初期化より前に Linux 固有の graphics policy を確定する。
configureLinuxGraphics(app);

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
  // electron-builder writes the packaged OS metadata; this runtime registration
  // also repairs the association when an installed package is launched directly.
  if (app.isPackaged && !app.setAsDefaultProtocolClient("grimodex")) {
    console.warn(
      "[grimodex-electron] failed to register the grimodex protocol handler",
    );
  }

  registerImeShutdown(app, getBackend);

  app.on("second-instance", (_event, argv) => {
    acceptWebEditorHandoffProtocolRequest(argv);
    const main = getWindow("main");
    if (!main) return;
    if (main.isMinimized()) main.restore();
    main.focus();
  });

  app.on("open-url", (event, url) => {
    if (acceptWebEditorHandoffProtocolRequest(url)) {
      event.preventDefault();
    }
  });

  registerSecurityHandlers(app);

  void app.whenReady().then(async () => {
    performance.mark("grimodex:electron-when-ready");
    // Migration / audit metadata must see the desktop app version, not the
    // grimodex-db crate version. Prefer an explicit override when present.
    const { resolveAppVersion } = await import("./shellCommands.js");
    process.env.GRIMODEX_APP_VERSION ??= resolveAppVersion();
    applySessionPermissionPolicy();
    // 本番ロード（§8 S8）: vite build 成果物 dist/ を app://bundle/ で配信。
    // main.cjs は <repo>/dist-electron/ に出るため dist は 1 つ上の隣。
    if (!process.env.ELECTRON_RENDERER_URL) {
      registerAppProtocolHandler(path.join(__dirname, "..", "dist"));
    }
    const startup = await initializeNarrativeMaintenanceStartup(
      configuredUserDataDir,
    );
    if (!startup) return;
    const {
      initializedBackend,
      profileEgress,
      narrativeMaintenanceCiSeam,
      narrativeMaintenanceCiHeldFreshnessWriter,
    } = startup;
    setExternalEgressGate(() => profileEgress.assertExternalUrl());
    const backend = wrapBackendForProductJourneyAi(
      initializedBackend,
      shouldUseProductJourneyAi({ isPackaged: app.isPackaged }),
    );
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
    // Resolution is lazy and singleflight so it cannot delay first window paint.
    const resolveMcpSidecar = prepareMcpSidecarForStartup(app.isPackaged, () =>
      resolveMcpSidecarPath(),
    );
    const mcpConfigHandlers = buildMcpConfigShellHandlers(
      backend,
      path.join(configuredUserDataDir, "license.json"),
      resolveMcpSidecar,
    );
    // external_mount（§2 バッチ2）: registry + chokidar watcher を持つ常駐
    // マネージャを 1 個生成し、その shell コマンドハンドラを invoke ルーターへ
    // 注入する。watcher イベントは backend event として全窓へ配信（external-mount://
    // の全窓 broadcast 契約）。
    const externalMount = createExternalMountManager(broadcastBackendEvent);
    // CLI AI（バッチ3c）: active child / abort / process-tree kill を invoke を跨いで
    // 共有する単一 manager。イベントは固定 cli:stream-* を全窓へ配信する。
    const cliAi = createCliAiManager(broadcastBackendEvent, {
      // 自動検出外のpathはrendererの文字列だけでは信頼しない。ユーザーがpathを
      // 見た上でnative dialogを明示許可した場合だけ、session allowlistへ入れる。
      authorizeExecutable: async (kind, executable, identity) => {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          title: "CLI実行の確認",
          message: `${kind} CLIを実行しますか？`,
          detail: [
            "Grimodexが次のcanonical実行ファイルを起動し、プロンプトをstdinで渡します。",
            "自分で設定した信頼できるCLIであることを確認してください。",
            "",
            executable,
            `SHA-256: ${identity.sha256}`,
          ].join("\n"),
          buttons: ["許可", "キャンセル"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return response === 0;
      },
    });
    // Codex App Serverはlazy起動。rendererには高水準commandだけを公開し、
    // workspace path / thread binding / read-only policyはmain側で確定する。
    const codexApp = createCodexAppServerManager({
      broadcast: broadcastBackendEvent,
      sendToOwner: sendBackendEventToWindow,
      getWorkspacePath: backend?.getActiveWorkspacePath
        ? () => backend.getActiveWorkspacePath!()
        : undefined,
      threadBindings: createRuntimeThreadBindingStore(backend),
      appVersion: app.getVersion(),
      codexHomeDir: path.join(configuredUserDataDir, "codex-app-server"),
      getConfiguredExecutable: async () =>
        (await readPersistedCodexAppServerSettings(backend)).binaryPath,
      authorizeExecutable: async ({ executable, sha256 }) => {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          title: "Codex App Server実行の確認",
          message: "Codex App Serverを実行しますか？",
          detail: [
            "Grimodexが次のcanonical実行ファイルを常駐起動します。",
            "自分でインストールした信頼できるCodex CLIであることを確認してください。",
            "",
            executable,
            `SHA-256: ${sha256 ?? "取得できませんでした"}`,
          ].join("\n"),
          buttons: ["許可", "キャンセル"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return response === 0;
      },
      getAllowApprovals: async () =>
        (await readPersistedCodexAppServerSettings(backend)).allowApprovals,
      getReadOnlyMcpServer: async (projectId, expectedWorkspacePath) => {
        const info = await mcpConfigHandlers.get_mcp_config({});
        if (typeof info !== "object" || info === null || Array.isArray(info)) {
          throw new Error("MCP config response is invalid");
        }
        const record = info as Record<string, unknown>;
        const command = record.command;
        const workspace = record.workspace;
        const argsPrefix = record.argsPrefix;
        if (
          typeof command !== "string" ||
          typeof workspace !== "string" ||
          !path.isAbsolute(command) ||
          !path.isAbsolute(workspace)
        ) {
          throw new Error("MCP config contains non-absolute paths");
        }
        if (realpathSync.native(workspace) !== expectedWorkspacePath) {
          throw new Error("MCP config does not match the active workspace");
        }
        const prefix = Array.isArray(argsPrefix)
          ? argsPrefix.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        return {
          command,
          args: [
            ...prefix,
            "--workspace",
            expectedWorkspacePath,
            "--project",
            projectId,
            "--readonly",
          ],
          env: {},
        };
      },
      appendAuditObservations: async (auditContext, observations) => {
        if (!backend?.aiAuditAppendBatch) {
          throw new Error("Native AI audit backend is unavailable");
        }
        const appVersion = app.getVersion();
        const events = observations.map((observation) => ({
          eventId: randomUUID(),
          executionId: auditContext.executionId,
          operationId: auditContext.operationId,
          parentExecutionId: auditContext.parentExecutionId,
          pathId: auditContext.pathId,
          eventType: "request.prepared",
          timestamp: Date.now(),
          payload: {
            captureState: observation.captureState,
            credentialsExcluded: true,
            effectiveRequestReceipt: true,
            request: {
              provider: observation.provider,
              ...(observation.model === null
                ? {}
                : { model: observation.model }),
              messages: observation.modelVisibleMessages,
              options: {
                runtime: "codex-app-server",
                rpcMethod: observation.rpcMethod,
                effort: observation.effort,
              },
              auditMetadata: {
                approvalPolicy: observation.approvalPolicy,
                sandboxMode: observation.sandboxMode,
                networkAccess: observation.networkAccess,
                retryWithoutMcp: observation.retryWithoutMcp,
                mcpObservation: observation.mcpObservation,
              },
            },
            limitations: observation.limitations,
            metadata: {
              source: "electron-main-before-codex-rpc",
              rpcMethod: observation.rpcMethod,
              effectiveRequestConfirmedByMain: true,
            },
            appVersion,
          },
        }));
        await backend.aiAuditAppendBatch(
          auditContext.expectedWorkspacePath,
          auditContext.projectId,
          events,
        );
      },
    });
    // Vivliostyle（バッチ5）: build/preview child、成果物token、tempをmain lifetime
    // で共有する。custom pathはnative確認を通したvivliostyle名だけを許可し、
    // 保存先はrendererから受けずnative dialogで選ぶ。
    const vivliostyle = createVivliostyleManager(broadcastBackendEvent, {
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
    const updater = createElectronUpdaterManager(broadcastMainEvent, {
      availability: updaterAvailability,
    });
    const mozkeyInstaller = createMozkeyInstallerManager();
    const licenseValidation = createLicenseValidationScheduler(
      backend,
      broadcastBackendEvent,
      {
        startEnabled: !profileEgress.restricted && !profileEgress.unavailable,
      },
    );
    // D2a activation is main-owned: close and drain all main-owned external
    // transports before Native persists the restricted profile state. These
    // callbacks never cross the renderer/preload contract.
    if (!profileEgress.unavailable) {
      profileEgress.registerMainEgressParticipant("cli-ai", () =>
        cliAi.quiesceForProfileEgress(),
      );
      profileEgress.registerMainEgressParticipant("codex-app-server", () =>
        codexApp.quiesceForProfileEgress(),
      );
      profileEgress.registerMainEgressParticipant("license-validation", () =>
        licenseValidation.quiesceForProfileEgress(),
      );
      profileEgress.registerMainEgressParticipant("vivliostyle", () =>
        vivliostyle.quiesceForProfileEgress(),
      );
    }
    let narrativeMaintenanceTriggers: NarrativeMaintenanceTriggerCoordinator | null =
      null;
    const narrativeFreshness = createNarrativeFreshnessScheduler(backend, {
      onCutoverNotReady: () => {
        narrativeMaintenanceTriggers?.requestBeforeCutoverPreparation();
      },
      onCycleCompleted: (observation) => {
        void Promise.resolve(
          narrativeMaintenanceCiHeldFreshnessWriter?.recordFreshness(
            observation,
          ),
        ).catch((error: unknown) => {
          // Held Freshness is a CI-only acceptance artifact. A failed observer
          // must remain diagnostic and never become an unhandled rejection in
          // an otherwise healthy production scheduler.
          console.warn(
            "[narrative-freshness] held-freshness receipt failed:",
            error,
          );
        });
      },
    });
    // Main-only system-work seam. Trigger discovery is owned by this process;
    // renderer/preload never supplies project scope, paths, or phase data.
    const { scheduler: narrativeMaintenance, coordinator } =
      bootstrapNarrativeMaintenance(backend, narrativeMaintenanceCiSeam);
    narrativeMaintenanceTriggers = coordinator;
    licenseValidation.start();
    if (!shouldDisableNarrativeFreshnessForLaunch(narrativeMaintenanceCiSeam)) {
      narrativeFreshness.start();
    }
    app.on("will-quit", () => {
      // close veto を通過して終了が確定してから同期 KILL する。before-quit で
      // dispose すると、未保存確認で終了を取り消した後も全 handler が死ぬ。
      vivliostyle.disposeAll();
      updater.dispose();
      licenseValidation.dispose();
      narrativeFreshness.dispose();
      narrativeMaintenanceTriggers?.dispose();
      narrativeMaintenance?.dispose();
      narrativeMaintenanceCiHeldFreshnessWriter?.dispose();
      cliAi.disposeAll();
      void codexApp.dispose();
      void externalMount.disposeAll();
    });
    // API キー保管（バッチ3a）: safeStorage 暗号化 + ai-keys.json。has/save/delete は
    // shell ハンドラ、チャット送信のキー解決は dispatchInvoke へ secrets として注入。
    const sharedShellHandlers = {
      ...externalMount.handlers,
      ...buildKeyStoreShellHandlers(keyStore),
      ...cliAi.handlers,
      ...vivliostyle.handlers,
      ...updater.handlers,
      ...mozkeyInstaller.handlers,
      ...mcpConfigHandlers,
    };
    const codexOwnerLifecycleBound = new Set<number>();
    registerIpcRouter(
      backend,
      (win) => {
        if (win && !codexOwnerLifecycleBound.has(win.webContents.id)) {
          const ownerId = win.webContents.id;
          codexOwnerLifecycleBound.add(ownerId);
          const releaseOwner = (): void => {
            if (!codexOwnerLifecycleBound.delete(ownerId)) return;
            void codexApp.handleOwnerDestroyed(ownerId);
          };
          win.webContents.once("render-process-gone", releaseOwner);
          win.webContents.once("destroyed", releaseOwner);
        }
        return {
          ...sharedShellHandlers,
          ...(win ? codexApp.handlersForOwner(win.webContents.id) : {}),
        };
      },
      keyStore,
      broadcastBackendEvent,
      narrativeMaintenanceCiSeam,
      profileEgress,
    );
    // TSFn 配線（backend.onEvent → 全窓 broadcast）を含む（§7.1、S7）。
    // 登録時に flush される backend:ready は窓生成前のため renderer には
    // 届かない（FE 購読者なしのデバッグチャネル — TSFn 実証は
    // workspace:opened が担う）。
    registerEventBus(
      backend,
      (channel, payload) => {
        narrativeFreshness.handleBackendEvent(channel, payload);
        narrativeMaintenanceTriggers?.handleBackendEvent(channel, payload);
        if (channel === "workspace:opened") {
          void codexApp.handleWorkspaceChanged();
        }
      },
      profileEgress,
    );
    performance.mark("grimodex:electron-create-main-window");
    const mainWindow = createMainWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      performance.mark("grimodex:renderer-finished-load");
      mainRendererReady = true;
      flushPendingWebEditorHandoff();
    });
    if (app.isPackaged && process.platform === "linux") {
      scheduleMcpSidecarWarmup(mainWindow, resolveMcpSidecar, (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(
          `[grimodex-electron] MCP sidecar background preparation failed: ${detail}`,
        );
      });
    }
    mainWindow.once("ready-to-show", () => {
      performance.mark("grimodex:electron-ready-to-show");
    });
  });

  // 単一アプリ窓の現行挙動に合わせ、macOS 含め全窓クローズで終了する（§6.5）。
  app.on("window-all-closed", () => {
    app.quit();
  });
}
