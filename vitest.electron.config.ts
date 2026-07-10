/// <reference types="vitest/config" />
/**
 * Electron main / shared の純関数部の単体テスト用 config
 * （設計書 §8 S4。既存 vitest.config.ts は include: ["src/**"] のため不変）。
 *
 * 実行: pnpm test:electron
 */
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    name: "electron",
    environment: "node",
    include: ["electron/{main,preload,shared}/**/*.test.ts"],
  },
});
