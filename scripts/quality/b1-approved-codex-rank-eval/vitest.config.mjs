import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export default defineConfig({
  root,
  resolve: { alias: { "@": path.join(root, "src") } },
  test: {
    name: "b1-approved-codex-rank-eval",
    globals: true,
    environment: "node",
    setupFiles: [path.join(root, "src/test-setup.ts")],
    include: ["scripts/quality/b1-approved-codex-rank-eval/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
