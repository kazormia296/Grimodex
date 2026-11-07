// DR-PUBG-16-2: the G-01 end-to-end diagnostic's admission — a new authority,
// so the tests pin how narrow it is: G-01's frozen fixture only, no formal
// reader accepts it, no other purpose gains a frozen fixture. No Electron.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DEV_PREVIEW_PURPOSES,
  G01_E2E_DIAGNOSTIC_PURPOSE,
  admitDevPreview,
  admitG01E2eDiagnostic,
  isLaunchAdmission,
  readAdmittedFixture,
  readG01E2eDiagnosticFixture,
} from "./admission.mjs";
import { G01_FIXTURE, GRAPH_CASE_FREEZE } from "./constants.mjs";
import { loadDevFixture } from "./dev-fixture.mjs";
import { ROOT, assertLaunchAdmitted } from "./launcher.mjs";
import { BINARY_MARKERS } from "./native-architecture.mjs";

const DEV = "scripts/quality/nir1-graph-eval/dev-fixtures/dev-lantern.v1.json";
const OTHER_FROZEN = "evals/nir1-graph/g02-directed-relation.v1.json";

const read = () => readG01E2eDiagnosticFixture({ root: ROOT });

test("the diagnostic reads G-01's frozen fixture only, by its fixed path and digest", () => {
  const loaded = read();
  assert.equal(loaded.path, G01_FIXTURE.path);
  assert.equal(loaded.sha256, G01_FIXTURE.sha256);
  assert.equal(loaded.fixture.fixtureId, G01_FIXTURE.fixtureId);
  assert.ok(Object.isFrozen(loaded));
  // The path is not an argument.
  assert.throws(
    () => readG01E2eDiagnosticFixture({ root: ROOT, path: OTHER_FROZEN }),
    /unsupported option path/u,
  );
  const root = mkdtempSync(path.join(os.tmpdir(), "g01-e2e-"));
  try {
    const full = path.join(root, G01_FIXTURE.path);
    mkdirSync(path.dirname(full), { recursive: true });
    // Other bytes at G-01's path (a changed fixture).
    writeFileSync(full, '{"fixtureId":"nir1-g01-explicit-pin-design/1"}');
    assert.throws(
      () => readG01E2eDiagnosticFixture({ root }),
      /bytes differ from the frozen G-01 digest/u,
    );
    // A symlink to the right bytes is refused too.
    rmSync(full);
    const real = path.join(root, "real.json");
    copyFileSync(path.join(ROOT, G01_FIXTURE.path), real);
    symlinkSync(real, full);
    assert.throws(
      () => readG01E2eDiagnosticFixture({ root }),
      /regular file, not a symlink/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the admission is bound to that read, says it counts for no judgement and takes no override", () => {
  const loaded = read();
  const admission = admitG01E2eDiagnostic({ fixture: loaded });
  assert.equal(admission.kind, G01_E2E_DIAGNOSTIC_PURPOSE);
  assert.equal(admission.purpose, G01_E2E_DIAGNOSTIC_PURPOSE);
  assert.equal(admission.fixturePath, G01_FIXTURE.path);
  assert.equal(admission.fixtureSha256, G01_FIXTURE.sha256);
  assert.equal(admission.countsInCaseJudgement, false);
  assert.equal(admission.session, "separate-diagnostic");
  assert.ok(Object.isFrozen(admission));
  assert.equal(isLaunchAdmission(admission), true);
  // Not the fixture's read: a path, a copy, a hand-made object, a dev fixture,
  // another frozen path, nothing.
  const dev = loadDevFixture({ root: ROOT, fixturePath: DEV });
  for (const fixture of [
    G01_FIXTURE.path,
    { ...loaded },
    { path: G01_FIXTURE.path, sha256: G01_FIXTURE.sha256 },
    { path: OTHER_FROZEN, sha256: "0".repeat(64) },
    dev,
    null,
    undefined,
  ])
    assert.throws(
      () => admitG01E2eDiagnostic({ fixture }),
      /readG01E2eDiagnosticFixture/u,
      String(fixture?.path ?? fixture),
    );
  // No override of the purpose or the judgement flag, nor any other key.
  for (const key of ["purpose", "countsInCaseJudgement", "session", "kind"])
    assert.throws(
      () => admitG01E2eDiagnostic({ fixture: loaded, [key]: "x" }),
      /unsupported option/u,
      key,
    );
  // Hand-made look-alikes never launch the evaluation build.
  for (const forged of [
    { ...admission },
    { kind: G01_E2E_DIAGNOSTIC_PURPOSE, countsInCaseJudgement: false },
  ])
    assert.equal(isLaunchAdmission(forged), false);
});

test("no formal reader accepts it, and no other purpose gains a frozen fixture", () => {
  const loaded = read();
  const admission = admitG01E2eDiagnostic({ fixture: loaded });
  // A formal fixture read needs admitGraphCaseRun's admission.
  for (const target of [G01_FIXTURE.path, OTHER_FROZEN])
    assert.throws(
      () => readAdmittedFixture(admission, { root: ROOT, path: target }),
      /admitGraphCaseRun/u,
      target,
    );
  // The purpose is not a dev-preview purpose: admitDevPreview refuses it,
  // with or without a fixture.
  assert.ok(!DEV_PREVIEW_PURPOSES.includes(G01_E2E_DIAGNOSTIC_PURPOSE));
  for (const fixture of [null, loaded])
    assert.throws(
      () => admitDevPreview({ purpose: G01_E2E_DIAGNOSTIC_PURPOSE, fixture }),
      /\[precheck\]/u,
    );
  // Every dev-preview purpose still refuses G-01's frozen fixture (the
  // diagnostic's read, and a dev loader pointed at its path).
  for (const purpose of DEV_PREVIEW_PURPOSES) {
    assert.throws(
      () => admitDevPreview({ purpose, fixture: loaded }),
      /loadDevFixture/u,
      purpose,
    );
    assert.throws(
      () =>
        admitDevPreview({
          purpose,
          fixture: loadDevFixture({
            root: ROOT,
            fixturePath: G01_FIXTURE.path,
          }),
        }),
      /not under the dev fixture directory/u,
      purpose,
    );
  }
  assert.throws(
    () => loadDevFixture({ root: ROOT, fixturePath: OTHER_FROZEN }),
    /not under the dev fixture directory/u,
  );
  // The freeze record is not material the diagnostic reads.
  assert.throws(
    () =>
      admitG01E2eDiagnostic({
        fixture: {
          path: GRAPH_CASE_FREEZE.path,
          sha256: GRAPH_CASE_FREEZE.sha256,
        },
      }),
    /readG01E2eDiagnosticFixture/u,
  );
});

test("the evaluation .node launches with it, recorded under its own admission name", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "g01-e2e-launch-"));
  try {
    mkdirSync(path.join(root, "electron/native/grimodex-node"), {
      recursive: true,
    });
    const evalNode = path.join(root, "eval.node");
    const bytes = `\0${BINARY_MARKERS.join("\0")}\0eval`;
    writeFileSync(evalNode, bytes);
    writeFileSync(
      path.join(root, "eval-build.json"),
      JSON.stringify({
        capabilities: { nir1GraphEval: true },
        artifacts: {
          "grimodex-node.node": createHash("sha256")
            .update(bytes)
            .digest("hex"),
        },
      }),
    );
    const admission = admitG01E2eDiagnostic({ fixture: read() });
    const launched = assertLaunchAdmitted({
      root,
      nativePath: evalNode,
      admission,
    });
    assert.equal(launched.evaluation, true);
    assert.equal(launched.admission, G01_E2E_DIAGNOSTIC_PURPOSE);
    assert.throws(
      () =>
        assertLaunchAdmitted({
          root,
          nativePath: evalNode,
          admission: { ...admission },
        }),
      /admission/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
