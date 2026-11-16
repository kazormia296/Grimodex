/// <reference types="vitest/config" />
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The eval renderer's own vitest tests (the k64 probe's pure functions). Not
// the product's config: that one includes `src` only, and the product source
// never names the eval renderer (D11 / T-2).
const root = path.resolve(__dirname, "../../..");

export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: [{ find: "@", replacement: path.resolve(root, "src") }] },
  test: {
    name: "cp4-probe",
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(root, "src/test-setup.ts")],
    include: ["scripts/quality/nir1-graph-eval/renderer/*.test.ts"],
  },
});
