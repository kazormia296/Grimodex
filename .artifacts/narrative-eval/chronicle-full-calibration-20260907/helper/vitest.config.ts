import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const helperRoot = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = process.env.TMPDIR
  ? path.join(process.env.TMPDIR, "vitest-cache")
  : path.join(path.dirname(helperRoot), "vitest-cache");

export default defineConfig({
  root: helperRoot,
  cacheDir,
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
  test: {
    name: "chronicle-llm-judge-live-helper",
    environment: "node",
    globals: true,
    include: ["*.test.ts"],
    testTimeout: 3_600_000,
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
