// 診断（diagnostic only）専用の vitest 設定。repo の既定 config は src/** だけを拾うので、
// この dir の試験は run.mjs（live）または `vitest --config` の明示で走らせる。
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
    name: "chronicle-prompt-cache-diag",
    globals: true,
    environment: "node",
    setupFiles: [path.join(root, "src/test-setup.ts")],
    include: ["scripts/quality/chronicle-prompt-cache-diag/**/*.test.ts"],
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 1000,
  },
});
