/**
 * 本番経路の起動スクリプト（設計書 §3.3 / §8 S8）。
 *
 * `pnpm electron:build` 済みの `dist/`（renderer）+ `dist-electron/`（main /
 * preload）を **app:// プロトコル**でロードして Electron を起動する
 * （ELECTRON_RENDERER_URL を渡さない = windows.ts が app://bundle/index.html
 * をロードする）。受け入れ条件 A9 の検証経路。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { rootDir } from "./build.mjs";

const require = createRequire(import.meta.url);

function fail(message) {
  console.error(`[electron:start] ${message}`);
  process.exit(1);
}

const mainCjs = path.join(rootDir, "dist-electron", "main.cjs");
if (!existsSync(mainCjs)) {
  fail("dist-electron/main.cjs がありません。`pnpm electron:build` を先に実行してください。");
}
if (!existsSync(path.join(rootDir, "dist", "index.html"))) {
  fail("dist/index.html がありません。`pnpm electron:build` を先に実行してください。");
}

const nodeBinary =
  process.env.GRIMODEX_NODE_PATH ??
  path.join(rootDir, "electron", "native", "grimodex-node", "grimodex-node.node");
if (!existsSync(nodeBinary)) {
  fail(
    `grimodex-node.node がありません: ${nodeBinary}\n` +
      "`pnpm napi:build` を先に実行してください。",
  );
}

let electronBin;
try {
  // Node から require("electron") すると実行バイナリのパス文字列が返る
  electronBin = require("electron");
} catch (err) {
  console.error(
    "[electron:start] electron バイナリを解決できませんでした。" +
      "ignore-scripts 環境では `node node_modules/electron/install.js` を一度実行してください。",
  );
  throw err;
}

// 本番経路: ELECTRON_RENDERER_URL を必ず外す（親シェルの残留値を遮断）
const env = { ...process.env };
delete env.ELECTRON_RENDERER_URL;

const child = spawn(electronBin, [mainCjs], {
  cwd: rootDir,
  stdio: "inherit",
  env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
