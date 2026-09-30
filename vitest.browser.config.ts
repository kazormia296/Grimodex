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
      "src/features/ai-policy/webAiConsent.gate-b2.browser.test.tsx",
      "src/features/editor/zen/ZenMultipassCanvas.browser.test.tsx",
      "src/features/editor/zen/ZenBlurResearchRunner.browser.test.tsx",
      "src/features/editor/zen/ZenShaderResearchRunner.browser.test.tsx",
      "src/features/editor/zen/ZenShaderAbbaResearchRunner.browser.test.tsx",
      "src/features/editor/zen/ZenShaderCadenceResearchRunner.browser.test.tsx",
      "src/features/editor/zen/ZenShaderBaselineResearchRunner.browser.test.tsx",
      "src/features/editor/zen/ZenShaderUpscaleResearchRunner.browser.test.tsx",
    ],
  },
});
