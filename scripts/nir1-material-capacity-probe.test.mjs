import Ajv2020 from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(root, "evals/nir1-capacity/manifest.v1.json");
const schemaPath = path.join(root, "evals/nir1-capacity/schema.v1.json");
const probePath = path.join(root, "scripts/nir1-material-capacity-probe.mjs");
const fixtureId = "Q513/R3/D0";

function makeWorkspace() {
  const directory = mkdtempSync(path.join(tmpdir(), "nir1-capacity-script-test-"));
  const fixtureDirectory = path.join(directory, "fixtures");
  const outputDirectory = path.join(directory, "output");
  mkdirSync(fixtureDirectory);
  const sourceDb = path.join(fixtureDirectory, fixtureId.replaceAll("/", "__") + ".db");
  writeFileSync(sourceDb, "preseeded-file-backed-db");
  writeFileSync(`${sourceDb}-wal`, "preseeded-wal");
  writeFileSync(`${sourceDb}-shm`, "preseeded-shm");
  return { directory, fixtureDirectory, outputDirectory, sourceDb };
}

function childReportSource({ mutate = false, mismatch = false, timeout = false } = {}) {
  const counts = mismatch
    ? { candidateRevisions: 3, qualifiedRevisions: 4, rejectedRevisions: 0, entityRecords: 0, relationRecords: 0, evidenceRecords: 0, qualifiedMaterialRecords: 513, rosterRecords: 513 }
    : { candidateRevisions: 3, qualifiedRevisions: 3, rejectedRevisions: 0, entityRecords: 255, relationRecords: 3, evidenceRecords: 255, qualifiedMaterialRecords: 513, rosterRecords: 513 };
  return [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    "const database = process.argv[2];",
    "const fixtureId = process.argv[3];",
    "const projectId = process.argv[4] ?? null;",
    timeout ? "await new Promise((resolve) => setTimeout(resolve, 250));" : "",
    mutate ? "writeFileSync(database, `mutated-main-${process.pid}`);" : "",
    mutate ? "writeFileSync(`${database}-wal`, `mutated-wal-${process.pid}`);" : "",
    mutate ? "writeFileSync(`${database}-shm`, `mutated-shm-${process.pid}`);" : "",
    `const report = ${JSON.stringify({
      diagnosticOnly: true,
      supportedCapacityClaim: false,
      fixtureId: "__fixture__",
      projectId: "__project__",
      processId: 1,
      status: "measured",
      admission: "diagnostic-only",
      counts,
      process: { elapsedMs: 1, hwmRssBytes: 2, ruMaxrssBytes: 2 },
      sql: { statementVmSteps: 3 },
      publishedGenerationBefore: 4,
      publishedGenerationAfter: 5,
      notMeasured: ["cancel-latency", "publish-transaction-occupancy"],
    })};`,
    "report.fixtureId = fixtureId;",
    "report.projectId = projectId;",
    "report.processId = process.pid;",
    "console.log(JSON.stringify(report));",
  ].filter(Boolean).join("\n");
}

function makeChild(directory, options) {
  const binary = path.join(directory, "fake-capacity-child.mjs");
  writeFileSync(binary, childReportSource(options));
  chmodSync(binary, 0o755);
  return binary;
}

function runProbe(workspace, binary, extraArgs = []) {
  return execFileSync(
    process.execPath,
    [
      probePath,
      binary,
      manifestPath,
      workspace.fixtureDirectory,
      workspace.outputDirectory,
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );
}

test("capacity manifest fixes the diagnostic matrix and Graph lifecycle boundary", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert.equal(manifest.schemaVersion, "nir1-capacity/1");
  assert.equal(manifest.schema, "schema.v1.json");
  assert.equal(schema.properties.diagnosticOnly.const, true);
  assert.equal(schema.properties.admissionBoundary.properties.currentMaterialLimit.const, 512);
  assert.equal(schema.properties.graphLifecycle.$ref, "#/$defs/graphLifecycle");
  assert.equal(manifest.graphLifecycle.queryActivation, "not-activated");
  assert.equal(manifest.graphLifecycle.productDispatch, "not-activated");
  assert.equal(manifest.graphLifecycle.supportedCapacityClaim, false);
  assert.equal(manifest.runProtocol.warmupCount, 1);
  assert.ok(manifest.runProtocol.measuredRunCount >= 5);
  assert.equal(manifest.runProtocol.sourceState, "immutable-main-wal-shm");
  assert.equal(manifest.runProtocol.childState, "record-before-and-after");
  assert.ok(manifest.runProtocol.childTimeoutMs > 0);
  assert.deepEqual(
    manifest.fixtures.map((fixture) => fixture.id),
    [
      "Q513/R3/D0",
      "Q513/R3/D516",
      "Q2044/R1022",
      "Q2044/R4",
      "Q2044/byte-heavy",
      "Q2044/evidence-shared",
      "Q2044/evidence-unique",
      "Q8176/R16",
      "D2064/report-heavy",
    ],
  );
  assert.ok(manifest.requiredMetrics.includes("temporaryBytes"));
  assert.ok(manifest.requiredMetrics.includes("cancelLatency"));
  for (const fixture of manifest.fixtures) {
    assert.ok(fixture.shape, `${fixture.id} must declare an observed shape`);
  }
});

test("manifest validates against its draft 2020-12 schema", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  const invalid = structuredClone(manifest);
  invalid.graphLifecycle.queryActivation = "activated";
  assert.equal(validate(invalid), false);
  assert.ok(validate.errors?.some((error) => error.instancePath.includes("queryActivation")));
});

test("CLI flags pass only the optional project id and preserve mutable child/source state", () => {
  const workspace = makeWorkspace();
  try {
    const binary = makeChild(workspace.directory, { mutate: true });
    const stdout = runProbe(workspace, binary, [
      "project-42",
      "--fixture",
      fixtureId,
      "--runs",
      "5",
      "--timeout-ms",
      "1000",
    ]);
    const report = JSON.parse(stdout);
    const result = report.results[0];
    assert.equal(report.diagnosticOnly, true);
    assert.equal(report.supportedCapacityClaim, false);
    assert.equal(report.graphQueryActivation, "not-activated");
    assert.equal(report.productDispatch, "not-activated");
    assert.equal(report.graphLifecycle.activated, false);
    assert.equal(report.protocol.measuredRunCount, 5);
    assert.equal(result.runs.length, 5);
    assert.equal(result.sourceStateStable, true);
    assert.equal(result.sourceState.main.present, true);
    assert.equal(result.sourceState.wal.present, true);
    assert.equal(result.sourceState.shm.present, true);
    assert.equal(result.sourceState.digest, result.sourceDatabaseDigest);
    assert.equal(result.warmup.projectId, "project-42");
    assert.equal(result.runs[0].projectId, "project-42");
    assert.notEqual(
      result.warmup.childDatabaseDigestBefore,
      result.warmup.childDatabaseDigestAfter,
    );
    assert.equal(result.warmup.publishedGenerationBefore, 4);
    assert.equal(result.warmup.publishedGenerationAfter, 5);
    assert.equal(result.warmup.childState.before.wal.present, true);
    assert.equal(result.warmup.childState.after.wal.digest === result.sourceState.wal.digest, false);
    assert.equal(readFileSync(workspace.sourceDb, "utf8"), "preseeded-file-backed-db");
    assert.equal(readFileSync(`${workspace.sourceDb}-wal`, "utf8"), "preseeded-wal");
    assert.equal(readFileSync(`${workspace.sourceDb}-shm`, "utf8"), "preseeded-shm");
    const processIds = [
      result.warmup.processId,
      ...result.runs.map((run) => run.processId),
    ];
    assert.equal(new Set(processIds).size, 6);
    assert.ok(result.notMeasured.includes("cancel-latency"));
    assert.ok(result.notMeasured.includes("publish-transaction-occupancy"));
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("child timeout is bounded and reports the fixture/run context", () => {
  const workspace = makeWorkspace();
  try {
    const binary = makeChild(workspace.directory, { timeout: true });
    assert.throws(
      () => runProbe(workspace, binary, ["--fixture", fixtureId, "--runs", "5", "--timeout-ms", "20"]),
      (error) => {
        assert.match(error.stderr, /Q513\/R3\/D0 warmup timed out after 20ms/);
        return true;
      },
    );
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("shape mismatch fails closed with the observed field and expected value", () => {
  const workspace = makeWorkspace();
  try {
    const binary = makeChild(workspace.directory, { mismatch: true });
    assert.throws(
      () => runProbe(workspace, binary, ["--fixture", fixtureId, "--runs", "5"]),
      (error) => {
        assert.match(error.stderr, /shape mismatch for qualified revisions: expected 3, observed 4/);
        return true;
      },
    );
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});
