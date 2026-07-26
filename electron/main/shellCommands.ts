/**
 * main-TS 実装のコマンド + ブリッジ実体（設計書 §4.3 / §5.4、Phase 2 S4）。
 *
 * 2 系統ある:
 * 1. **Tauri コマンド互換**（grim:invoke ルーター経由、Envelope は ipcContract の
 *    dispatchInvoke が畳む）: export / logs
 * 2. **ブリッジ native API**（dialog / fs / openExternal / getVersion / zoom /
 *    windowControls — 専用チャネル + Envelope。preload 側で解封して
 *    Promise reject に変換する）
 */
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import {
  clampZoomFactor,
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
import { readUtf8FileWithLimit } from "./boundedFileRead.js";
import { FsScope } from "./fsScope.js";

// 64 MiB SQLite payloadはbase64で約85.34 MiBになる。最大メタデータを含む
// version 1 JSONを許容しつつ、main/renderer双方の文字列・JSON parseを固定上限にする。
export const WEB_EDITOR_HANDOFF_MAX_FILE_BYTES = 86 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Tauri コマンド互換（grim:invoke ルーターから呼ばれる）
// ─────────────────────────────────────────────────────────────────────────────

/** export / Vivliostyle が共有する、renderer非指定のnative保存dialog入力。 */
export interface SavePathDialogOptions {
  suggestedName: string;
  filterName: string;
  extensions: string[];
}

/**
 * ログディレクトリ（Rust 側 `lint_logging::log_dir()` と同一パス:
 * `~/.grimodex/logs`。home 解決不能時は tmp フォールバックも同じ）。
 */
export function defaultLogDir(): string {
  const home = os.homedir();
  const base = home !== "" ? home : os.tmpdir();
  return path.join(base, ".grimodex", "logs");
}

function requireArgString(args: CommandArgs, key: string, cmd: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a string`,
    );
  }
  return value;
}

/**
 * export 系の保存ダイアログ（Rust 側 `export::prompt_save_path` の写像 —
 * PIO-2: renderer はデータ + 推奨ファイル名のみ渡し、書き込み先パスを
 * 一切渡さない。パスはダイアログ由来の user-chosen path に限られる）。
 * キャンセル時は null。
 */
export async function showSavePathDialog(
  win: BrowserWindow | null,
  options: SavePathDialogOptions,
): Promise<string | null> {
  const dialogOptions = {
    defaultPath: options.suggestedName,
    filters: [{ name: options.filterName, extensions: options.extensions }],
  };
  const result = win
    ? await dialog.showSaveDialog(win, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);
  return result.canceled || !result.filePath ? null : result.filePath;
}

async function promptSavePath(
  win: BrowserWindow | null,
  cmd: string,
  args: CommandArgs,
): Promise<string | null> {
  const suggestedName = requireArgString(args, "suggestedName", cmd);
  const filterName = requireArgString(args, "filterName", cmd);
  const extensions = Array.isArray(args.extensions)
    ? args.extensions.filter((e): e is string => typeof e === "string")
    : [];
  return showSavePathDialog(win, {
    suggestedName,
    filterName,
    extensions,
  });
}

/** Buffer.from は不正文字を黙って読み飛ばすため、Rust 側 base64 crate と同じく明示拒否する。 */
function decodeBase64Strict(b64: string): Buffer {
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error("invalid base64 export payload");
  }
  return Buffer.from(b64, "base64");
}

/**
 * invoke 1 件ぶんの main-TS コマンドハンドラを組み立てる。
 * `win` は保存ダイアログの親となる送信元窓。
 * `logDir` はテスト注入点（既定は Rust と同一の `~/.grimodex/logs`）。
 */
export function buildShellCommandHandlers(
  win: BrowserWindow | null,
  logDir: string = defaultLogDir(),
): ShellCommandHandlers {
  return {
    // export 系（commands/export.rs の写像）: 保存できたら絶対パス、
    // キャンセル時は null（Tauri ワイヤと同形）。
    export_save_text: async (args: CommandArgs) => {
      const contents = requireArgString(args, "contents", "export_save_text");
      const picked = await promptSavePath(win, "export_save_text", args);
      if (picked === null) return null;
      await writeFile(picked, contents, "utf8");
      return picked;
    },
    export_save_bytes: async (args: CommandArgs) => {
      const bytes = decodeBase64Strict(
        requireArgString(args, "contentsBase64", "export_save_bytes"),
      );
      const picked = await promptSavePath(win, "export_save_bytes", args);
      if (picked === null) return null;
      await writeFile(picked, bytes);
      return picked;
    },
    // commands/logs.rs の写像: フォルダが無ければ作成を試み（best-effort）、
    // OS のファイルマネージャで開く。
    open_log_dir: async () => {
      await mkdir(logDir, { recursive: true }).catch(() => {});
      const openError = await shell.openPath(logDir);
      if (openError !== "") {
        throw new Error(`ログフォルダを開けませんでした: ${openError}`);
      }
      return null;
    },
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
 * リポジトリルートの package.json（Electron版バージョンの唯一の正本）へフォールバックする。
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
      case "toggleFullscreen": {
        const next = !win.isFullScreen();
        win.setFullScreen(next);
        return next;
      }
      case "isFullscreen":
        return win.isFullScreen();
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

  handleWithEnvelope(IPC.dialogOpenWebEditorHandoff, async (event) => {
    const options = {
      properties: ["openFile" as const],
      filters: [
        {
          name: "Grimodex Web Editor handoff",
          extensions: ["grimodex-handoff"],
        },
      ],
    };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    if (picked === null) return null;
    if (path.extname(picked).toLowerCase() !== ".grimodex-handoff") {
      throw new Error("WEB_EDITOR_HANDOFF_INVALID_EXTENSION");
    }
    return {
      name: path.basename(picked),
      content: await readUtf8FileWithLimit(picked, {
        maxBytes: WEB_EDITOR_HANDOFF_MAX_FILE_BYTES,
        notFileError: () => new Error("WEB_EDITOR_HANDOFF_NOT_A_FILE"),
        tooLargeError: () =>
          new Error(
            `WEB_EDITOR_HANDOFF_FILE_TOO_LARGE: selected handoff exceeds ${WEB_EDITOR_HANDOFF_MAX_FILE_BYTES} bytes`,
          ),
      }),
    };
  });

  handleWithEnvelope(IPC.fsReadTextFile, async (_event, path) => {
    const real = await fsScope.assertReadable(requireStringArg(path, "path"), {
      asFile: true,
    });
    return readFile(real, "utf8");
  });

  handleWithEnvelope(IPC.fsReadDir, async (_event, path) => {
    const real = await fsScope.assertReadable(requireStringArg(path, "path"), {
      asFile: false,
    });
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
    const o = (opts ?? {}) as {
      width?: unknown;
      height?: unknown;
      title?: unknown;
    };
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
