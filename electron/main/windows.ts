/**
 * BrowserWindow ファクトリ + label レジストリ + ウィンドウクローム配線
 * （設計書 §6、Phase 2 S6）。
 *
 * - メイン窓の生成パリティは §6.1 の表（純関数 buildMainWindowOptions —
 *   windowChrome.ts — が組み立て、window-state 復元がデフォルトに優先）
 * - §6.3: maximize/unmaximize/resize → `grim:window-resized` 通知
 * - §6.4: close veto 非同期プロトコル（純関数 createCloseVetoController）
 * - §6.7: windowState.ts 接続（resize/move の debounce 保存 + 復元）
 * - §6.1: メニュー方針（win/linux は null、macOS は zoom ロールなしの最小構成）
 * - パネル別窓 panel-* は S7 で実装する（§6.5）。
 */
import path from "node:path";

import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";

import { IPC } from "../shared/ipcContract.js";
import {
  applicationMenuPolicy,
  buildMainWindowOptions,
  createCloseVetoController,
} from "./windowChrome.js";
import type { CloseVetoController } from "./windowChrome.js";
import { createWindowStateStore } from "./windowState.js";
import type { WindowStateStore } from "./windowState.js";

const registry = new Map<string, BrowserWindow>();

/** webContents.id → 進行中 close veto（grim:close-reply のルーティング先）。 */
const vetoControllers = new Map<number, CloseVetoController>();

let stateStore: WindowStateStore | null = null;

/** label に対応する生存中の窓を返す（破棄済みは undefined）。 */
export function getWindow(label: string): BrowserWindow | undefined {
  const win = registry.get(label);
  return win && !win.isDestroyed() ? win : undefined;
}

function track(label: string, win: BrowserWindow): void {
  registry.set(label, win);
  win.on("closed", () => {
    if (registry.get(label) === win) registry.delete(label);
  });
}

/** §6.1 メニュー方針: zoomHotkeysEnabled:false パリティ（zoom ロールなし）。 */
function applyApplicationMenu(): void {
  const policy = applicationMenuPolicy(process.platform);
  if (policy.kind === "null") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(policy.roles.map((role) => ({ role }))),
  );
}

/**
 * クローム共通初期化（app ready 後、初回の窓生成時に 1 回だけ）:
 * - アプリケーションメニュー方針（§6.1）
 * - window-state store（§6.7）+ quit 時 flush
 * - close veto の renderer 応答チャネル（§6.4 手順 2/4 の受け口。
 *   webContents.id で送信元窓のコントローラへルーティングする）
 */
function ensureChrome(): WindowStateStore {
  if (stateStore) return stateStore;

  applyApplicationMenu();

  stateStore = createWindowStateStore(app.getPath("userData"));
  app.on("before-quit", () => stateStore?.flush());

  ipcMain.on(IPC.closeReply, (event, payload: unknown) => {
    const veto =
      typeof payload === "object" &&
      payload !== null &&
      (payload as { veto?: unknown }).veto === true;
    vetoControllers.get(event.sender.id)?.onReply(veto);
  });
  ipcMain.on(IPC.closeHandlerChanged, (event, count: unknown) => {
    vetoControllers
      .get(event.sender.id)
      ?.setHandlerRegistered(typeof count === "number" && count > 0);
  });

  return stateStore;
}

/**
 * 窓 1 枚ぶんのクローム配線（§6.3 / §6.4 / §6.7）。
 * パネル別窓（S7、§6.5）もこの関数を label 違いで再利用する想定。
 */
function attachWindowChrome(
  label: string,
  win: BrowserWindow,
  store: WindowStateStore,
): void {
  const webContentsId = win.webContents.id;

  // §6.3: 既存の「onResized → isMaximized 再取得」（WindowControls.tsx）を
  // 無改修で動かす通知。maximize/unmaximize も Tauri の onResized と同様に流す。
  const notifyResized = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.windowResized);
  };

  // §6.7: 保存は store 側で 500ms debounce。getNormalBounds() により
  // maximized 中も「unmaximize 後に戻るサイズ」を保持する。
  const saveState = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return;
    store.set(label, {
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
    });
  };

  win.on("resize", () => {
    notifyResized();
    saveState();
  });
  win.on("move", saveState);
  win.on("maximize", () => {
    notifyResized();
    saveState();
  });
  win.on("unmaximize", () => {
    notifyResized();
    saveState();
  });

  // §6.4: close veto 非同期プロトコル
  const controller = createCloseVetoController({
    requestClose: () => {
      if (!win.isDestroyed()) win.webContents.send(IPC.closeRequested);
    },
    forceClose: () => {
      if (!win.isDestroyed()) win.close();
    },
  });
  vetoControllers.set(webContentsId, controller);

  win.on("close", (e) => {
    if (!controller.onCloseEvent()) e.preventDefault();
  });
  win.on("closed", () => {
    controller.dispose();
    vetoControllers.delete(webContentsId);
    store.flush();
  });
}

/**
 * メイン窓を生成する。既に生存していればフォーカスして返す。
 * tauri.conf.json とのパリティ + window-state 復元は §6.1 / §6.7
 * （組み立ては windowChrome.ts の純関数）。
 */
export function createMainWindow(): BrowserWindow {
  const existing = getWindow("main");
  if (existing) {
    existing.focus();
    return existing;
  }

  const store = ensureChrome();
  const { options, startMaximized } = buildMainWindowOptions({
    platform: process.platform,
    savedState: store.get("main"),
    displayWorkAreas: screen.getAllDisplays().map((d) => d.workArea),
  });

  const win = new BrowserWindow({
    ...options,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  track("main", win);
  attachWindowChrome("main", win, store);

  win.once("ready-to-show", () => {
    // maximize() は非表示窓を表示させる副作用があるため show の直前に行う
    if (startMaximized) win.maximize();
    win.show();
    // map 後に WM が constructor の x/y を上書きする環境がある
    // （実測: XWayland + Mutter で同一 state から 0,0 化が非決定的に発生）。
    // 表示が落ち着いてから一度だけ復元位置を再適用する。Wayland では位置
    // 指定自体を WM が無視しうるため best-effort — Tauri の window-state
    // プラグインと同じ制約（サイズ復元は常に効く）。
    if (!startMaximized && options.x !== undefined && options.y !== undefined) {
      const { x, y } = options;
      setTimeout(() => {
        if (win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
        const current = win.getBounds();
        if (current.x !== x || current.y !== y) win.setPosition(x, y);
      }, 250);
    }
  });

  win.webContents.on("did-finish-load", () => {
    // dev オーケストレータ / スモークスクリプトが起動確認に使うマーカーログ。
    console.log(
      `[grimodex-electron] renderer loaded: ${win.webContents.getURL()}`,
    );
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    // 本番ロード（app:// プロトコル）は S8 で実装する（§8 S8）。
    console.error(
      "[grimodex-electron] ELECTRON_RENDERER_URL が未設定です。" +
        "Phase 2 S3 時点では `pnpm electron:dev` からの起動のみサポートします。",
    );
  }

  return win;
}
