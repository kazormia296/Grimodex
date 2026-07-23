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
 * - §6.5: パネル別窓 panel-*（S7）— label 検証 + URL は main が組み立てる。
 *   メイン窓 closed で全パネル窓を閉じる（window-all-closed → quit は index.ts）
 */
import path from "node:path";

import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";

import { IPC } from "../shared/ipcContract.js";
import { PROD_INDEX_URL } from "./protocol.js";
import {
  applicationMenuPolicy,
  buildMainWindowOptions,
  buildPanelUrl,
  buildPanelWindowOptions,
  createCloseVetoController,
  isValidPanelLabel,
  PANEL_WINDOW_LABEL_PREFIX,
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
  // 無改修で動かす通知。maximize/unmaximize/fullscreen も Tauri の
  // onResized と同様に流し、renderer が native state を再取得できるようにする。
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
  win.on("enter-full-screen", notifyResized);
  win.on("leave-full-screen", notifyResized);

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

/** 全窓共通の webPreferences（§5.1 セキュリティ前提）。 */
function buildWebPreferences(): BrowserWindowConstructorOptions["webPreferences"] {
  return {
    preload: path.join(__dirname, "preload.cjs"),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  };
}

/**
 * ready-to-show または did-finish-load の早い方で表示し、復元位置を再適用
 * （メイン窓 / パネル窓共通）。transparent + show:false の窓では環境によって
 * ready-to-show が発火せず、非表示 renderer の rAF も停止して永久に表示不能に
 * なるため、document load 完了を安全な fallback とする。
 * maximize() は非表示窓を表示させる副作用があるため show の直前に行う。
 */
function showWhenReady(
  win: BrowserWindow,
  options: BrowserWindowConstructorOptions,
  startMaximized: boolean,
): void {
  let revealed = false;
  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
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
  };

  win.once("ready-to-show", reveal);

  win.webContents.on("did-finish-load", () => {
    // dev オーケストレータ / スモークスクリプトが起動確認に使うマーカーログ。
    console.log(
      `[grimodex-electron] renderer loaded: ${win.webContents.getURL()}`,
    );
    reveal();
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
    webPreferences: buildWebPreferences(),
  });
  track("main", win);
  attachWindowChrome("main", win, store);
  showWhenReady(win, options, startMaximized);

  // §6.5: メイン窓 closed で全パネル窓を閉じる（残った窓が無くなれば
  // window-all-closed → app.quit()（index.ts）で終了する）。
  win.on("closed", () => {
    closeAllPanelWindows();
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    // 本番ロード（§8 S8）: app://bundle/index.html（dist/ 配信は protocol.ts。
    // ハンドラ登録は index.ts が app ready 直後に行う）。
    void win.loadURL(PROD_INDEX_URL);
  }

  return win;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6.5 パネル別窓（S7）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * パネル窓を開く（`grim:panel-open` の実体 — ipc.ts が shellCommands の
 * delegate として注入する）。
 * - label は `/^panel-[a-z0-9-]+$/` で検証（不正は throw → envelope エラー）
 * - URL は main が label から組み立てる（renderer 供給 URL 拒否 — §6.5）
 * - 既存窓があれば focus のみ（Tauri の openPanelWindow と同じ冪等挙動）
 * - window-state は label 別に復元/保存（attachWindowChrome を再利用）
 */
export function openPanelWindow(
  label: string,
  requested: { width?: unknown; height?: unknown; title?: unknown },
): void {
  if (!isValidPanelLabel(label)) {
    throw new Error(`invalid panel window label: ${String(label)}`);
  }
  const existing = getWindow(label);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const store = ensureChrome();
  const { options, startMaximized } = buildPanelWindowOptions({
    savedState: store.get(label),
    displayWorkAreas: screen.getAllDisplays().map((d) => d.workArea),
    requested,
  });

  const win = new BrowserWindow({
    ...options,
    webPreferences: buildWebPreferences(),
  });
  track(label, win);
  attachWindowChrome(label, win, store);
  showWhenReady(win, options, startMaximized);

  void win.loadURL(buildPanelUrl(process.env.ELECTRON_RENDERER_URL, label));
}

/**
 * label のパネル窓が生存していれば focus して true（`grim:panel-focus-by-label`
 * の実体）。renderer 側 getWebviewWindowByLabel の存在確認に使われる。
 */
export function focusPanelWindow(label: string): boolean {
  if (!isValidPanelLabel(label)) return false;
  const win = getWindow(label);
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.focus();
  return true;
}

/** 生存中の全パネル窓に close を要求する（veto プロトコル §6.4 を通る）。 */
function closeAllPanelWindows(): void {
  for (const [label, win] of [...registry]) {
    if (!label.startsWith(PANEL_WINDOW_LABEL_PREFIX)) continue;
    if (!win.isDestroyed()) win.close();
  }
}
