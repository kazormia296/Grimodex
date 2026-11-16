// Runs the eval renderer's vitest tests (renderer/cp4-k64-probe.test.ts: the
// probe's rows are the product's fused display rows) from the node test glob.
// The product's vitest config includes `src` only, so these have their own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

test("the k64 probe's rowTextsOf and graphEvidenceOf read the fused display rows (vitest)", () => {
  const require = createRequire(path.join(root, "package.json"));
  const bin = path.join(
    path.dirname(require.resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const run = spawnSync(
    process.execPath,
    [
      bin,
      "run",
      "--config",
      path.join(here, "vitest.probe.config.ts"),
      "--reporter",
      "dot",
    ],
    { cwd: root, encoding: "utf8", timeout: 240_000 },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
