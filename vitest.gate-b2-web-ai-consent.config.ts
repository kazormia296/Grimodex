/// <reference types="vitest/config" />
import { realpathSync } from "node:fs";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { playwright } from "@vitest/browser-playwright";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} for Gate B2 browser journey`);
  return value;
}

const alias = { "@": path.resolve(__dirname, "./src") };
const dependencyRoot = realpathSync(path.resolve(__dirname, "node_modules"));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  define: {
    __GATE_B2_PROVIDER_BASE_URL__: JSON.stringify(
      requiredEnvironment("GATE_B2_PROVIDER_BASE_URL"),
    ),
    __GATE_B2_PROVIDER_STATS_URL__: JSON.stringify(
      requiredEnvironment("GATE_B2_PROVIDER_STATS_URL"),
    ),
    __GATE_B2_EVIDENCE_URL__: JSON.stringify(
      requiredEnvironment("GATE_B2_EVIDENCE_URL"),
    ),
  },
  server: {
    fs: {
      allow: [...new Set([searchForWorkspaceRoot(__dirname), dependencyRoot])],
    },
  },
  optimizeDeps: {
    include: ["@tanstack/react-virtual"],
  },
  test: {
    name: "gate-b2-web-ai-consent-browser",
    globals: true,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    setupFiles: ["./src/test-setup-browser.ts"],
    include: [
      "src/features/ai-policy/webAiConsent.gate-b2.browser.test.tsx",
    ],
  },
});
