// license共有Rust runtimeのnapi境界（Electron移行 Phase 3e）。
// 通常の開発/ベータbuildはlicensing feature無効であり、4 commandは常時export
// される一方、license.jsonへ触れずdisabled DTO / 明示errorを返す。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-license-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const appDataDir = join(root, "app-data");
const licensePath = join(appDataDir, "license.json");
const backend = new Backend(appDataDir);

const DISABLED_DTO = {
  licensingEnabled: false,
  status: "disabled",
  trialDaysRemaining: null,
  graceDaysRemaining: null,
  keyTail: null,
  activatedAt: null,
  lastValidatedAt: null,
};

test("getLicenseStateはfeature無効でも常時存在し、exact disabled DTOを返してfileを作らない", async () => {
  assert.equal(typeof backend.getLicenseState, "function");
  assert.deepEqual(JSON.parse(await backend.getLicenseState()), DISABLED_DTO);
  assert.equal(existsSync(licensePath), false);
});

test("feature無効buildのwrite 3 commandは同じ明示errorでrejectし副作用を残さない", async () => {
  for (const invoke of [
    () => backend.activateLicense("GRIM-KEY-1234"),
    () => backend.revalidateLicense(),
    () => backend.deactivateLicense(),
  ]) {
    await assert.rejects(invoke(), (error) => {
      assert.match(
        String(error.message),
        /このビルドではライセンス機構が無効です/,
      );
      return true;
    });
  }
  assert.equal(existsSync(licensePath), false);
});

test("background validate cycleはfeature無効buildでnullを返しfileを作らない", async () => {
  assert.equal(typeof backend.runLicenseValidateCycle, "function");
  assert.equal(await backend.runLicenseValidateCycle(), null);
  assert.equal(existsSync(licensePath), false);
});
