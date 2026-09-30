/// <reference types="vitest/config" />
import { realpathSync } from "node:fs";
import path from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";

const alias = { "@": path.resolve(__dirname, "./src") };
const dependencyRoot = realpathSync(path.resolve(__dirname, "node_modules"));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  server: {
    watch: {
      // Keep source watching while avoiding generated CI and Cargo trees.
      // Vite appends these patterns to its node_modules/cache exclusions.
      ignored: [
        path.resolve(__dirname, ".artifacts/**"),
        path.resolve(__dirname, "src-tauri/target/**"),
        path.resolve(__dirname, "electron/native/**/target/**"),
        path.resolve(__dirname, "target/**"),
      ],
    },
    fs: {
      allow: [...new Set([searchForWorkspaceRoot(__dirname), dependencyRoot])],
    },
  },
  optimizeDeps: {
    include: ["@tanstack/react-virtual"],
  },
  test: {
    name: "zen-shader-webgl",
    globals: true,
    maxWorkers: 1,
    browser: {
      enabled: true,
      api: { host: "127.0.0.1", port: 45124 },
      connectTimeout: 180_000,
      fileParallelism: false,
      provider: playwright({
        launchOptions: {
          args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
        },
      }),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    setupFiles: ["./src/test-setup-browser.ts"],
    include: [
      "src/features/editor/zen/ZenBlurResearchCanvas.browser.test.tsx",
      "src/features/editor/zen/ZenShaderResearchSurface.browser.test.tsx",
      "src/features/editor/zen/ZenShaderResearchAbba.browser.test.tsx",
      "src/features/editor/zen/ZenShaderUpscaleResearch.browser.test.tsx",
    ],
  },
});
