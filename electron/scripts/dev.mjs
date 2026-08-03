/**
 * Electron 開発オーケストレータ（設計書 §3.2 / §3.3）。
 *
 * 1. vite dev server を port 1430 / strictPort で起動
 *    （vite 8 は bin の直接 require を exports で塞いでいるため、CLI spawn
 *    ではなく createServer を使う）
 * 2. esbuild watch で electron/main + electron/preload → dist-electron/
 * 3. ELECTRON_RENDERER_URL=http://localhost:1430 で Electron を起動
 *    （main / preload の再ビルドで Electron を再起動。renderer の HMR は vite が担う）
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import esbuild from "esbuild";
import { createServer } from "vite";

import { bundleConfigs, rootDir } from "./build.mjs";

const require = createRequire(import.meta.url);

const RENDERER_PORT = 1430;
const RENDERER_URL = `http://localhost:${RENDERER_PORT}`;

/** @type {import("vite").ViteDevServer | null} */
let viteServer = null;
/** @type {import("node:child_process").ChildProcess | null} */
let electronProc = null;
/** @type {import("esbuild").BuildContext[]} */
const buildContexts = [];

let shuttingDown = false;
let electronPhase = false; // 初回ビルド完了前の onEnd で再起動しないためのゲート
let restartQueued = false;

function log(message) {
  console.log(`[electron:dev] ${message}`);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electronProc && electronProc.exitCode === null) {
    electronProc.kill("SIGTERM");
  }
  const closers = [
    ...buildContexts.map((ctx) => ctx.dispose()),
    viteServer ? viteServer.close() : Promise.resolve(),
  ];
  void Promise.allSettled(closers).finally(() => process.exit(code));
}

async function startVite() {
  viteServer = await createServer({
    root: rootDir,
    server: { port: RENDERER_PORT, strictPort: true },
  });
  await viteServer.listen();
  log(`vite dev server: ${RENDERER_URL}`);
}

function resolveElectronBinary() {
  try {
    // Node から require("electron") すると実行バイナリのパス文字列が返る
    return require("electron");
  } catch (err) {
    log(
      "electron バイナリを解決できませんでした。ignore-scripts 環境では " +
        "`node node_modules/electron/install.js` を一度実行してください。",
    );
    throw err;
  }
}

function startElectron() {
  if (shuttingDown) return;
  const electronBin = resolveElectronBinary();
  electronProc = spawn(electronBin, ["dist-electron/main.cjs"], {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: RENDERER_URL,
      GRIMODEX_WORKSPACE_OPEN_TRACE: "1",
    },
  });
  electronProc.on("exit", (code) => {
    electronProc = null;
    if (shuttingDown) return;
    if (restartQueued) {
      restartQueued = false;
      startElectron();
      return;
    }
    log("Electron が終了しました。開発サーバーを停止します。");
    shutdown(code ?? 0);
  });
}

function restartElectron() {
  if (!electronPhase || shuttingDown) return;
  if (electronProc) {
    if (!restartQueued) {
      restartQueued = true;
      electronProc.kill("SIGTERM");
    }
    return;
  }
  startElectron();
}

async function startEsbuildWatch() {
  // 各 context の初回ビルド完了を待ってから Electron を起動する
  // （watch() の resolve は初回ビルド完了を保証しないため、onEnd で同期する）。
  /** @type {Promise<void>[]} */
  const firstBuilds = [];
  for (const config of bundleConfigs) {
    /** @type {() => void} */
    let resolveFirstBuild;
    firstBuilds.push(
      new Promise((resolve) => {
        resolveFirstBuild = resolve;
      }),
    );
    const ctx = await esbuild.context({
      ...config,
      plugins: [
        {
          name: "electron-restart",
          setup(build) {
            build.onEnd((result) => {
              resolveFirstBuild();
              if (result.errors.length > 0) {
                log("esbuild エラー — Electron の再起動を保留します");
                return;
              }
              if (electronPhase) {
                log("main/preload を再ビルド → Electron を再起動します");
                restartElectron();
              }
            });
          },
        },
      ],
    });
    buildContexts.push(ctx);
    await ctx.watch();
  }
  await Promise.all(firstBuilds);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  await startVite();
  await startEsbuildWatch();
} catch (err) {
  console.error(err);
  shutdown(1);
  // process.exit は dispose 完了後に走るため、ここでは何もしない
}

if (!shuttingDown) {
  electronPhase = true;
  log(`renderer: ${RENDERER_URL} / main: dist-electron/main.cjs`);
  startElectron();
}
