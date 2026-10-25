/** Verify the generated `.node` is a release artifact with every paid-v2 gate. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const nativePath = path.join(
  rootDir,
  "electron/native/grimodex-node/grimodex-node.node",
);
const native = require(nativePath);
const { Backend } = native;
const temp = mkdtempSync(path.join(tmpdir(), "grimodex-release-native-"));

try {
  const backend = new Backend(temp);
  assert.equal(typeof backend.getNativeBuildCapabilities, "function");
  assert.deepEqual(JSON.parse(await backend.getNativeBuildCapabilities()), {
    licensing: true,
    legacyKeyringMigration: true,
    nir1FinalRequestEval: false,
    nir1GraphEval: false,
  });
  // CP-4 S1a: the evaluation-only Graph functions never ship.
  assert.deepEqual(
    Object.keys(native).filter((name) => name.startsWith("nir1GraphEval")),
    [],
  );
  const license = JSON.parse(await backend.getLicenseState());
  assert.equal(license.licensingEnabled, true);
  assert.equal(typeof backend.readLegacyApiKeysForMigration, "function");
  console.log("[release-native] licensing + legacy keyring migration enabled");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
