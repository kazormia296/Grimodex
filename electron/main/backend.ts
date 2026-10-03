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
  Backend: new (
    appDataDir: string,
    semanticResourceRoot?: string | null,
    rerankerResourceRoot?: string | null,
  ) => NapiBackendLike;
}

interface SemanticResourceResolution {
  isPackaged: boolean;
  resourcesPath: string;
  mainDir: string;
  userDataPath?: string;
}

interface RerankerResourceResolution {
  isPackaged: boolean;
  resourcesPath?: string;
  mainDir: string;
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
 * Semantic tokenizer / optional bundled model root. Native側でcwdやbuild時の
 * CARGO_MANIFEST_DIRへfallbackせず、実行シェルがdev/packageの配置を確定して渡す。
 * package側はPhase 4のelectron-builder extraResources配置と対応する。
 */
export function resolveSemanticResourceRoot(
  resolution: SemanticResourceResolution = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname,
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (resolution.isPackaged) {
    return path.join(resolution.resourcesPath, "resources", "semantic");
  }
  const ownerToken = env.GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN;
  if (
    typeof ownerToken === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      ownerToken,
    )
  ) {
    // The deterministic renderer fixture keeps semantic scheduling and IPC,
    // but expects the normal model-unavailable result. Its fresh userData
    // already isolates downloaded models; also exclude repository bundles.
    return path.join(
      resolution.userDataPath ?? app.getPath("userData"),
      "runtime-performance",
      "semantic",
    );
  }
  return path.join(
    resolution.mainDir,
    "..",
    "src-tauri",
    "resources",
    "semantic",
  );
}

/**
 * Selected Gate 2 reranker snapshots are bundled at a fixed package path.
 * Development may point at a different verified snapshot root with an
 * absolute override.
 */
export function resolveRerankerResourceRoot(
  resolution: RerankerResourceResolution = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname,
  },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (resolution.isPackaged) {
    return path.join(
      resolution.resourcesPath ?? process.resourcesPath,
      "resources",
      "reranker",
      "phase0b",
    );
  }
  const override = env.GRIMODEX_RERANKER_RESOURCE_ROOT?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error(
        "GRIMODEX_RERANKER_RESOURCE_ROOT must be an absolute path",
      );
    }
    return override;
  }
  return path.join(
    resolution.mainDir,
    "..",
    "experiments",
    "lfm25-encoder-phase0",
    "local",
    "phase0b",
  );
}

/**
 * app ready 後に 1 回だけ呼ぶ。Backend コンストラクタには起動ロック前に
 * `configureAppUserData` が確定した `app.getPath("userData")` を明示注入する。
 * packaged版は既存Tauriのdata_dir、developmentはGrimodexElectronDevを使う。
 */
export interface InitBackendOptions {
  /** CI product-journey launches must not fail-soft into a passing window. */
  failFast?: boolean;
}

export function initBackend({
  failFast = false,
}: InitBackendOptions = {}): NapiBackendLike | null {
  const binaryPath = resolveNodeBinaryPath();
  const semanticResourceRoot = resolveSemanticResourceRoot();
  try {
    const rerankerResourceRoot = resolveRerankerResourceRoot();
    if (!existsSync(binaryPath)) {
      throw new Error(
        `grimodex-node.node が見つかりません: ${binaryPath}\n` +
          "`pnpm napi:build` を実行してから起動し直してください。",
      );
    }
    // esbuild バンドル外の実行時 require（*.node は external — §3.2）
    const requireNative = createRequire(__filename);
    const mod = requireNative(binaryPath) as GrimodexNodeModule;
    instance = new mod.Backend(
      app.getPath("userData"),
      semanticResourceRoot,
      rerankerResourceRoot,
    );
    console.log(`[grimodex-electron] napi backend loaded: ${binaryPath}`);
    return instance;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[grimodex-electron] napi backend load failed: ${message}`);
    if (failFast) {
      instance = null;
      throw e instanceof Error ? e : new Error(message);
    }
    dialog.showErrorBox(
      "Grimodex バックエンドの読み込みに失敗しました",
      `${message}\n\nDB を伴う機能は動作しません（fail-soft で起動は継続します）。`,
    );
    instance = null;
    return null;
  }
}
