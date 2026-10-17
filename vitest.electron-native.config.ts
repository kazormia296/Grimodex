/// <reference types="vitest/config" />
/**
 * 実 Native（N-API addon）を載せる Electron main の pipeline 試験用 config
 * （NIR-1 DA-1 DR-DA1-9）。既存の `electron` stage は addon を持たないので、
 * `*.pipeline.spec.ts` はこの config だけが拾う（`vitest.electron.config.ts` の
 * include は `*.test.ts` なので重ならない）。
 *
 * 実行（addon を作った後）:
 *   pnpm napi:build
 *   pnpm exec vitest --config vitest.electron-native.config.ts --run
 */
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    name: "electron-native",
    environment: "node",
    include: ["electron/main/**/*.pipeline.spec.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    fileParallelism: false,
  },
});
