/**
 * Electron main / preload / mastra-agent の esbuild バンドル（設計書 §3.2）。
 *
 * electron-vite は使わず手組み: platform=node / format=cjs /
 * external=["electron", "*.node"] / 出力 dist-electron/。
 * dev.mjs からは bundleConfigs を import して watch モードで使う。
 *
 * - 3 つ目の bundle `dist-electron/mastra-agent.cjs`（Mastra 移行 MP-3a、docs/plans/mastra-mp3-decisions.md
 *   の DR-MP3-18）は、`@mastra/*` を入れる唯一の bundle。main／preload には入れない。MP-3a では製品の
 *   どこからも require しない。`.map` は作らない（asar に ee 由来の source を残さない）。
 * - 全 bundle に ee の stub plugin を当てる（Mastra の ee は bundle に入れない）。検査は
 *   `node electron/scripts/mastra-ee-check.mjs --dist`。
 * - `bundleConfigs[0]` は main に保つ（mastra-ee-check.mjs が esbuild の共通設定をここから取る）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

import { eeStubPlugin } from "./mastra-ee-stub-plugin.mjs";

export const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  // Electron 43 同梱 Node 系の構文レベル。
  target: "node22",
  external: ["electron", "*.node"],
  sourcemap: true,
  logLevel: "info",
};

/**
 * config の plugins に、呼び手の plugin を後ろへ足した配列を返す（上書きしない）。
 * dev.mjs の watch が `plugins` を差し替えて ee の stub を落とさないための合成。
 *
 * @param {import("esbuild").BuildOptions} config
 * @param {import("esbuild").Plugin[]} extra
 * @returns {import("esbuild").Plugin[]}
 */
export function composePlugins(config, extra = []) {
  return [...(config.plugins ?? []), ...extra];
}

/** @type {import("esbuild").BuildOptions[]} */
export const bundleConfigs = [
  {
    ...common,
    entryPoints: [path.join(rootDir, "electron", "main", "index.ts")],
    outfile: path.join(rootDir, "dist-electron", "main.cjs"),
    plugins: [eeStubPlugin()],
  },
  {
    ...common,
    entryPoints: [path.join(rootDir, "electron", "preload", "index.ts")],
    outfile: path.join(rootDir, "dist-electron", "preload.cjs"),
    plugins: [eeStubPlugin()],
  },
  {
    ...common,
    entryPoints: [
      path.join(rootDir, "electron", "main", "mastra", "agentRuntime.ts"),
    ],
    outfile: path.join(rootDir, "dist-electron", "mastra-agent.cjs"),
    sourcemap: false,
    plugins: [eeStubPlugin()],
  },
];

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await Promise.all(bundleConfigs.map((config) => esbuild.build(config)));
}
