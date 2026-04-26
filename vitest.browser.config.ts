/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { playwright } from "@vitest/browser-playwright";

const alias = { "@": path.resolve(__dirname, "./src") };

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
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
  },
});
