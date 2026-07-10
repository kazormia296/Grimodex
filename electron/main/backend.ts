/**
 * grimodex-node (.node) のロードと Backend インスタンス管理
 * （設計書 §2 / §8 S4。失敗時はエラーダイアログ + fail-soft で起動継続 —
 * napi コマンドは IPC_BACKEND_UNAVAILABLE の明示エラーになる）。
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

import { app, dialog } from "electron";

import type { NapiBackendLike } from "../shared/ipcContract.js";

interface GrimodexNodeModule {
  Backend: new (appDataDir: string) => NapiBackendLike;
}

let instance: NapiBackendLike | null = null;

export function getBackend(): NapiBackendLike | null {
  return instance;
}

/**
 * .node の解決順:
 * 1. `GRIMODEX_NODE_PATH`（スモーク / テストからの明示注入）
 * 2. dev 配置: `<repo>/electron/native/grimodex-node/grimodex-node.node`
 *    （main.cjs は `<repo>/dist-electron/` に出るため 1 つ上がリポジトリルート。
 *    パッケージ配置（asarUnpack）は Phase 4 — 正本 §11）
 */
export function resolveNodeBinaryPath(): string {
  const override = process.env.GRIMODEX_NODE_PATH;
  if (override) return override;
  return path.join(
    __dirname,
    "..",
    "electron",
    "native",
    "grimodex-node",
    "grimodex-node.node",
  );
}

/**
 * app ready 後に 1 回だけ呼ぶ。Backend コンストラクタには
 * `app.getPath("userData")` を明示注入する（§4.2 / §6.8 — Phase 2 は
 * GrimodexElectronDev 名の userData に隔離し Tauri のデータに触らない）。
 */
export function initBackend(): NapiBackendLike | null {
  const binaryPath = resolveNodeBinaryPath();
  try {
    if (!existsSync(binaryPath)) {
      throw new Error(
        `grimodex-node.node が見つかりません: ${binaryPath}\n` +
          "`pnpm napi:build` を実行してから起動し直してください。",
      );
    }
    // esbuild バンドル外の実行時 require（*.node は external — §3.2）
    const requireNative = createRequire(__filename);
    const mod = requireNative(binaryPath) as GrimodexNodeModule;
    instance = new mod.Backend(app.getPath("userData"));
    console.log(`[grimodex-electron] napi backend loaded: ${binaryPath}`);
    return instance;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[grimodex-electron] napi backend load failed: ${message}`);
    dialog.showErrorBox(
      "Grimodex バックエンドの読み込みに失敗しました",
      `${message}\n\nDB を伴う機能は動作しません（fail-soft で起動は継続します）。`,
    );
    instance = null;
    return null;
  }
}
