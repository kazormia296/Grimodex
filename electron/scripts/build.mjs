/**
 * Electron main / preload の esbuild バンドル（設計書 §3.2）。
 *
 * electron-vite は使わず手組み: platform=node / format=cjs /
 * external=["electron", "*.node"] / 出力 dist-electron/。
 * dev.mjs からは bundleConfigs を import して watch モードで使う。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

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

/** @type {import("esbuild").BuildOptions[]} */
export const bundleConfigs = [
  {
    ...common,
    entryPoints: [path.join(rootDir, "electron", "main", "index.ts")],
    outfile: path.join(rootDir, "dist-electron", "main.cjs"),
  },
  {
    ...common,
    entryPoints: [path.join(rootDir, "electron", "preload", "index.ts")],
    outfile: path.join(rootDir, "dist-electron", "preload.cjs"),
  },
];

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await Promise.all(bundleConfigs.map((config) => esbuild.build(config)));
}
