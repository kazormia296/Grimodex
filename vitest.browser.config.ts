/// <reference types="vitest/config" />
import { realpathSync } from "node:fs";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { playwright } from "@vitest/browser-playwright";

const alias = { "@": path.resolve(__dirname, "./src") };
const dependencyRoot = realpathSync(path.resolve(__dirname, "node_modules"));

export default defineConfig({
  // Tailwind 4 は utilities を Vite plugin 経由で生成する。これが無いと
  // browser test で `grid` `h-full` 等のクラスが no-op になり、layout が
  // 全く効かない (shell が display:block に潰れる)。
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  server: {
    fs: {
      // Worktrees may reuse a dependency tree through a node_modules symlink.
      // Fontsource URLs resolve to its real path during browser tests.
      allow: [...new Set([searchForWorkspaceRoot(__dirname), dependencyRoot])],
    },
  },
  optimizeDeps: {
    include: ["@tanstack/react-virtual"],
  },
  test: {
    name: "browser",
    globals: true,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    setupFiles: ["./src/test-setup-browser.ts"],
    include: ["src/**/*.browser.test.{ts,tsx}"],
    exclude: [
      "src/features/editor/zen/ZenMultipassCanvas.browser.test.tsx",
      "src/features/editor/zen/ZenBlurResearchRunner.browser.test.tsx",
    ],
  },
});
