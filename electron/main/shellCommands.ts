/**
 * main-TS 実装のコマンド + ブリッジ実体（設計書 §4.3 / §5.4、Phase 2 S4）。
 *
 * 2 系統ある:
 * 1. **Tauri コマンド互換**（grim:invoke ルーター経由、Envelope は ipcContract の
 *    dispatchInvoke が畳む）: set_window_vibrancy / get_license_state スタブ
 * 2. **ブリッジ native API**（dialog / fs / openExternal / getVersion / zoom /
 *    windowControls — 専用チャネル + Envelope。preload 側で解封して
 *    Promise reject に変換する）
 */
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import {
  clampZoomFactor,
  DISABLED_LICENSE_STATE,
  IPC,
  isSafeExternalUrl,
  toErrorString,
  unimplementedError,
} from "../shared/ipcContract.js";
import type {
  CommandArgs,
  Envelope,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";
import { FsScope } from "./fsScope.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Tauri コマンド互換（grim:invoke ルーターから呼ばれる）
// ─────────────────────────────────────────────────────────────────────────────

/** テスト用の最小窓インターフェース（BrowserWindow は構造的に満たす）。 */
export interface VibrancyWindowLike {
  setVibrancy(type: "under-window" | null): void;
}

/**
 * invoke 1 件ぶんの main-TS コマンドハンドラを組み立てる。
 * `win` は送信元窓（set_window_vibrancy の対象。Rust 実装と同じく
 * macOS 以外は no-op — §6.6）。
 */
export function buildShellCommandHandlers(
  win: VibrancyWindowLike | null,
  platform: NodeJS.Platform = process.platform,
): ShellCommandHandlers {
  return {
    set_window_vibrancy: (args: CommandArgs) => {
      const enabled = args.enabled === true;
      if (platform === "darwin" && win) {
        win.setVibrancy(enabled ? "under-window" : null);
      }
      return Promise.resolve(null);
    },
    // licensing 無効ビルドと同一形状（§4.3。Phase 3 で napi へ差し替え）
    get_license_state: () => Promise.resolve({ ...DISABLED_LICENSE_STATE }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ブリッジ native API（専用チャネル）
// ─────────────────────────────────────────────────────────────────────────────

type BridgeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown> | unknown;

/** ハンドラを Envelope に畳んで登録する（main は決して throw しない — §5.2）。 */
function handleWithEnvelope(channel: string, handler: BridgeHandler): void {
  ipcMain.handle(channel, async (event, ...args): Promise<Envelope> => {
    try {
      return { ok: true, value: await handler(event, ...args) };
    } catch (e) {
      return { ok: false, error: toErrorString(e) };
    }
  });
}

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) throw new Error("no BrowserWindow for the invoking webContents");
  return win;
}

function requireStringArg(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`invalid bridge argument \`${name}\`: expected a string`);
  }
  return value;
}

let cachedVersion: string | null = null;

/**
 * dev（default_app 経由の `electron dist-electron/main.cjs` 起動）では
 * app.getVersion() が package.json を解決できず "0.0" を返すため、
 * リポジトリルートの package.json（正本 4 箇所の一つ）へフォールバックする。
 * パッケージ配布（Phase 4）では app.getVersion() がそのまま正になる。
 */
function resolveAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  let version = app.getVersion();
  if (!app.isPackaged && version === "0.0") {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
      ) as { version?: unknown };
      if (typeof pkg.version === "string") version = pkg.version;
    } catch {
      // フォールバック失敗時は "0.0" のまま（致命ではない）
    }
  }
  cachedVersion = version;
  return version;
}

/**
 * パネル別窓操作の注入点（§6.5、S7）。実体は windows.ts の
 * openPanelWindow / focusPanelWindow — ipc.ts が注入する。ここで直接
 * import しないのは、shellCommands 単体テスト（electron モック）へ
 * windows.ts の依存（Menu / screen / window-state fs）を持ち込まないため。
 */
export interface PanelWindowDelegate {
  open(
    label: string,
    opts: { width?: unknown; height?: unknown; title?: unknown },
  ): void;
  focusByLabel(label: string): boolean;
}

/**
 * ブリッジ native API（§5.4 の dialog / fs / openExternal / getVersion /
 * zoom / windowControls / panelWindow）。
 *
 * fs はダイアログ許可制（fsScope.ts）: dialog.openFolder / openFile で
 * ユーザーが選んだパスだけがスコープに入り、readTextFile / readDir は
 * スコープ外を FS_SCOPE_DENIED で拒否する。
 */
export function registerShellBridgeHandlers(
  panelWindows?: PanelWindowDelegate,
  fsScope: FsScope = new FsScope(),
): void {
  handleWithEnvelope(IPC.windowControl, (event, op) => {
    const win = senderWindow(event);
    switch (op) {
      case "minimize":
        win.minimize();
        return null;
      case "toggleMaximize":
        if (win.isMaximized()) {
          win.unmaximize();
        } else {
          win.maximize();
        }
        return null;
      case "close":
        // win.close() は windows.ts の close veto プロトコル（§6.4）を通る
        win.close();
        return null;
      case "isMaximized":
        return win.isMaximized();
      default:
        throw new Error(`unknown window control op: ${String(op)}`);
    }
  });

  handleWithEnvelope(IPC.dialogOpenFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ["openDirectory" as const] };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    if (picked !== null) await fsScope.allowDir(picked);
    return picked;
  });

  handleWithEnvelope(IPC.dialogOpenFile, async (event, filter) => {
    const f = (filter ?? {}) as { name?: unknown; extensions?: unknown };
    const name = typeof f.name === "string" ? f.name : "Files";
    const extensions = Array.isArray(f.extensions)
      ? f.extensions.filter((e): e is string => typeof e === "string")
      : [];
    const options = {
      properties: ["openFile" as const],
      filters: [{ name, extensions }],
    };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    if (picked !== null) await fsScope.allowFile(picked);
    return picked;
  });

  handleWithEnvelope(IPC.fsReadTextFile, async (_event, path) => {
    const real = await fsScope.assertReadable(
      requireStringArg(path, "path"),
      { asFile: true },
    );
    return readFile(real, "utf8");
  });

  handleWithEnvelope(IPC.fsReadDir, async (_event, path) => {
    const real = await fsScope.assertReadable(
      requireStringArg(path, "path"),
      { asFile: false },
    );
    const entries = await readdir(real, {
      withFileTypes: true,
    });
    // plugin-fs の DirEntry と同形（src/lib/fs.ts）
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      isSymlink: e.isSymbolicLink(),
    }));
  });

  handleWithEnvelope(IPC.openExternal, async (_event, url) => {
    const target = requireStringArg(url, "url");
    // scheme allowlist 再検証 = src/lib/safeUrl.ts と二重防御（§3.4）
    if (!isSafeExternalUrl(target)) {
      throw new Error(`blocked external URL (unsafe scheme): ${target}`);
    }
    await shell.openExternal(target);
    return null;
  });

  handleWithEnvelope(IPC.getVersion, () => resolveAppVersion());

  handleWithEnvelope(IPC.setZoomFactor, (event, factor) => {
    event.sender.setZoomFactor(clampZoomFactor(factor));
    return null;
  });

  // パネル別窓（§6.5、S7）。delegate 未注入（単体テスト等）は S4 と同じ
  // IPC_UNIMPLEMENTED の明示エラーへ fail-soft する。
  handleWithEnvelope(IPC.panelOpen, (_event, label, opts) => {
    if (!panelWindows) throw new Error(unimplementedError("panelWindow.open"));
    const o = (opts ?? {}) as { width?: unknown; height?: unknown; title?: unknown };
    panelWindows.open(requireStringArg(label, "label"), o);
    return null;
  });
  handleWithEnvelope(IPC.panelFocus, (_event, label) => {
    if (!panelWindows) {
      throw new Error(unimplementedError("panelWindow.focusByLabel"));
    }
    return panelWindows.focusByLabel(requireStringArg(label, "label"));
  });
}
