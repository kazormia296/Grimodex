// NIR-1 DA-1 (K3/2 Negative (1)・Positive (1)(7)): 実 Native を載せる Electron main の
// pipeline 試験（electron/main/*.pipeline.spec.ts）を、この native stage から実行する。
//
// `*.pipeline.spec.ts` は `vitest.electron.config.ts` の include（`*.test.ts`）に載らず、
// `vitest.electron-native.config.ts` だけが拾う。その config を呼ぶ CI stage がなかったので、
// 外へ出す経路の行 1〜6 の到達 0 件などが退行しても Quick／Full は緑のままだった。
// この stage は `pnpm napi:build` の後に走り（addon がある）、`node --test` が必ず拾う
// （local-ci の native.public-tests と .github/workflows/ci.yml の同じ command）。
// 新しい registry task や workflow の step を足さないので、実行される suite の台帳は変わらない。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const vitestBin = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const addon = path.join(repoRoot, "electron", "native", "grimodex-node", "grimodex-node.node");

test("Electron main の pipeline 試験（vitest.electron-native.config.ts）が通る", () => {
  assert.ok(existsSync(vitestBin), `vitest が見つからない: ${vitestBin}`);
  assert.ok(existsSync(addon), `addon がない（napi:build の後に実行する）: ${addon}`);

  const result = spawnSync(
    process.execPath,
    [vitestBin, "--config", "vitest.electron-native.config.ts", "--run"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: "1" },
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `vitest が失敗した\n${output}`);
  assert.match(output, /Test Files\s+\d+ passed/, output);
  assert.doesNotMatch(output, /\bfailed\b/i, output);
});
