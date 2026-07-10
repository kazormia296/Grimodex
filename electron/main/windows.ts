/**
 * BrowserWindow ファクトリ + label レジストリ（Phase 2 S3 骨格）。
 *
 * - メイン窓の生成パリティは設計書 §6.1 の表に従う
 *   （window-state 復元は S4、close veto / macOS titleBarStyle / メニューは S6、
 *   パネル別窓 panel-* は S7 で実装する）。
 */
import path from "node:path";

import { BrowserWindow } from "electron";

const registry = new Map<string, BrowserWindow>();

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

/**
 * メイン窓を生成する。既に生存していればフォーカスして返す。
 * tauri.conf.json とのパリティ: 800x600 / min 600x400 / decorations:false /
 * transparent:true（§6.1）。
 */
export function createMainWindow(): BrowserWindow {
  const existing = getWindow("main");
  if (existing) {
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    // macOS の titleBarStyle:"hidden" 分岐は S6 で入れる（§6.1）。
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  track("main", win);

  win.once("ready-to-show", () => {
    win.show();
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
