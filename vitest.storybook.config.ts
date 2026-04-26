/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import storybookTest from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";

const alias = { "@": path.resolve(__dirname, "./src") };

export default defineConfig({
  plugins: [react(), await storybookTest({ configDir: ".storybook" })],
  resolve: { alias },
  test: {
    globals: true,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    setupFiles: [".storybook/vitest.setup.ts"],
  },
});
