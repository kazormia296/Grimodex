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
    // live の 30 回は順に送るので、effort high の Sonnet では 60 秒を超える。
    testTimeout: 1_800_000,
  },
});
