// Shape check of a standard-build receipt, shared by the producer
// (standard-build.mjs) and the Graph arm admission (contract.mjs). It has no
// process, file or network dependency so either side can import it.
import assert from "node:assert/strict";
import path from "node:path";

export const REQUIRED_ARTIFACTS = [
  "dist/index.html",
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "electron/native/grimodex-node/grimodex-node.node",
];
const SHA256 = /^[0-9a-f]{64}$/u;

export function validateStandardBuildSuccessReceipt(receipt, fixture = false) {
  assert.equal(
    receipt.schemaVersion,
    fixture ? "nir1-standard-build-fixture/1" : "nir1-standard-build/1",
  );
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.standardBuild, !fixture);
  assert.equal(receipt.sourceUnchanged, true);
  assert.ok(path.isAbsolute(receipt.root));
  assert.ok(receipt.candidate?.worktreeClean === true);
  for (const field of [
    "resolvedBaseSha",
    "resolvedHeadSha",
    "resolvedHeadTreeSha",
  ])
    assert.match(receipt.candidate[field], /^[0-9a-f]{40,64}$/u);
  assert.equal(
    receipt.candidate.currentHeadSha,
    receipt.candidate.resolvedHeadSha,
  );
  assert.ok(path.isAbsolute(receipt.sourceManifest));
  assert.match(receipt.sourceManifestSha256, SHA256);
  assert.deepEqual(
    receipt.commands.map(({ argv, exitCode }) => ({ argv, exitCode })),
    [
      { argv: ["pnpm", "napi:build"], exitCode: 0 },
      { argv: ["pnpm", "electron:build"], exitCode: 0 },
    ],
  );
  assert.ok(
    receipt.commands.every(
      (command) =>
        command.status === "passed" &&
        command.closeObserved === true &&
        command.termination === "close-and-group-exit-observed" &&
        command.cleanup?.complete === true,
    ),
  );
  assert.deepEqual(Object.keys(receipt.artifacts), REQUIRED_ARTIFACTS);
  for (const digest of Object.values(receipt.artifacts))
    assert.match(digest, SHA256);
}
