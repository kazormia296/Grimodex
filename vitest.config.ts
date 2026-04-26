/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import storybookTest from "@storybook/addon-vitest/vitest-plugin";

const alias = { "@": path.resolve(__dirname, "./src") };

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "node",
          globals: true,
          environment: "node",
          setupFiles: ["./src/test-setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.browser.test.{ts,tsx}"],
        },
      },
      {
        plugins: [
          react(),
          // transforms *.stories.tsx into Vitest test suites
          await storybookTest({ configDir: ".storybook" }),
        ],
        resolve: { alias },
        test: {
          name: "browser",
          globals: true,
          browser: {
            enabled: true,
            provider: "playwright",
            name: "chromium",
            headless: true,
          },
          setupFiles: [
            ".storybook/vitest.setup.ts",
            "./src/test-setup-browser.ts",
          ],
          include: [
            "src/**/*.browser.test.{ts,tsx}",
            "src/**/*.stories.{ts,tsx}",
          ],
        },
      },
    ],
  },
});
