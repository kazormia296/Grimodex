import Ajv2020 from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function makeWorkspace(selectedFixture = fixtureId) {
  const directory = mkdtempSync(path.join(tmpdir(), "nir1-capacity-script-test-"));
  const fixtureDirectory = path.join(directory, "fixtures");
  const outputDirectory = path.join(directory, "output");
  mkdirSync(fixtureDirectory);
  const sourceDb = path.join(fixtureDirectory, selectedFixture.replaceAll("/", "__") + ".db");
  writeFileSync(sourceDb, "preseeded-file-backed-db");
  writeFileSync(`${sourceDb}-wal`, "preseeded-wal");
  writeFileSync(`${sourceDb}-shm`, "preseeded-shm");
  return { directory, fixtureDirectory, outputDirectory, sourceDb };
}

function childReportSource({ fixtureForReport = fixtureId, mutate = false, mismatch = false, mismatchField = null, fixtureShapeReportRecords = null, malformed = false, timeout = false, leakyDescendant = false, detachedDescendant = false, writeProjectMarker = false, enforceSingleChildCopy = false, omitMode = false, supportedCapacityClaim = false, failedMode = false, operationReportRecords = null, sourceSnapshotDependencyEdges = null } = {}) {
  const fixtureCounts = {
    [fixtureId]: { candidateRevisions: 3, qualifiedRevisions: 3, rejectedRevisions: 0, entityRecords: 255, relationRecords: 3, evidenceRecords: 255, qualifiedMaterialRecords: 513, rosterRecords: 513, dependencyEdges: null, graphSnapshotDependencyEdges: null, reportRecords: null },
    "Q8176/R16": { candidateRevisions: 16, qualifiedRevisions: 16, rejectedRevisions: 0, entityRecords: 4080, relationRecords: 16, evidenceRecords: 4080, qualifiedMaterialRecords: 8176, rosterRecords: 8176, dependencyEdges: null, graphSnapshotDependencyEdges: null, reportRecords: null },
    "Q2044/evidence-shared": { candidateRevisions: 4, qualifiedRevisions: 4, rejectedRevisions: 0, entityRecords: 1020, relationRecords: 4, evidenceRecords: 1020, qualifiedMaterialRecords: 2044, rosterRecords: 2044, dependencyEdges: 1028, graphSnapshotDependencyEdges: 257, reportRecords: null },
    "Q2044/evidence-unique": { candidateRevisions: 4, qualifiedRevisions: 4, rejectedRevisions: 0, entityRecords: 1020, relationRecords: 4, evidenceRecords: 1020, qualifiedMaterialRecords: 2044, rosterRecords: 2044, dependencyEdges: 1028, graphSnapshotDependencyEdges: 1025, reportRecords: null },
    "D2064/report-heavy": { candidateRevisions: 2064, qualifiedRevisions: 0, rejectedRevisions: 2064, entityRecords: 0, relationRecords: 0, evidenceRecords: 0, qualifiedMaterialRecords: 0, rosterRecords: 0, dependencyEdges: 4128, graphSnapshotDependencyEdges: 1, reportRecords: 416 },
  };
  const counts = structuredClone(fixtureCounts[fixtureForReport] ?? fixtureCounts[fixtureId]);
  if (mismatch) counts.qualifiedRevisions = 4;
  if (mismatchField) counts[mismatchField] = Number(counts[mismatchField]) - 1;
  const fixtureShape = structuredClone(counts);
  fixtureShape.graphSnapshotDependencyEdges = null;
  if (fixtureShapeReportRecords !== null) fixtureShape.reportRecords = fixtureShapeReportRecords;
  return [
    "#!/usr/bin/env node",
    'import { spawn } from "node:child_process";',
    'import { readdirSync, writeFileSync } from "node:fs";',
    'import { dirname } from "node:path";',
    "const database = process.argv[2];",
    "const fixtureId = process.argv[3];",
    "const projectId = process.argv[4] ?? null;",
    timeout ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);" : "",
    leakyDescendant ? "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'inherit' }); descendant.unref();" : "",
    detachedDescendant ? "const descendant = spawn('setsid', ['env', '-i', process.execPath, '-e', 'setTimeout(() => {}, 2000)'], { stdio: 'inherit' }); if (projectId) writeFileSync(projectId, String(descendant.pid)); descendant.unref();" : "",
    writeProjectMarker ? "if (projectId) writeFileSync(projectId, 'child-ran');" : "",
    enforceSingleChildCopy ? "if (readdirSync(dirname(database)).filter((name) => name.endsWith('.db')).length !== 1) { console.error('prior disposable child DB was retained'); process.exit(91); }" : "",
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
      databasePath: "child.db",
      counts,
      fixtureShape,
      bytes: { payloadBytes: 0, envelopeBytes: 0, sourceBasisBytes: 0, liveSourceBytes: null, rosterBytes: 0, revisionIdOverheadBytes: 0 },
      process: { elapsedMs: 1, userCpuUs: 1, systemCpuUs: 1, rssBytes: 2, hwmRssBytes: 2, ruMaxrssBytes: 2, sqliteMemoryBytes: 2, sqliteMemoryHighwaterBytes: 2, rustHeap: null, readBytes: 0, writeBytes: 0, temporaryBytesMethod: "fake", temporaryBytesCoverage: "fake", temporaryBytesUncertainty: "fake", temporaryDisk: null },
      sql: { statementVmSteps: 3, exactVmSteps: false, vmStepsKind: "profiled-subset-lower-bound", progressCallbacks: 0, statements: 1, openedConnections: 1, closedConnections: 1, method: "fake", coverage: "fake", lifecycleVmStepsUpperBound: null, lifecycleVmStepsMethod: "fake", lifecycleVmStepsCoverage: "fake", sqliteSourceId: "fake" },
      occupancy: { connectionHoldMs: 1, publishTransactionMs: null, foregroundWaitMs: null, foregroundWaitScope: null, foregroundWaitMethod: null, foregroundWaitUncertainty: null },
      graphLifecycle: {},
      modeOutcome: { operation: "fake", success: true, requiredSuccess: true, operationReportRecords: null },
      cancel: { status: "not-run", latencyMs: null, scope: null, method: null, uncertainty: null },
      interruptionProbes: [],
      rejectionReasons: {},
      publishedGenerationBefore: 4,
      publishedGenerationAfter: 5,
      notMeasured: ["cancel-latency", "publish-transaction-occupancy"],
    })};`,
    "report.fixtureId = fixtureId;",
    omitMode ? "" : "report.mode = process.argv.at(-1);",
    `report.supportedCapacityClaim = ${JSON.stringify(supportedCapacityClaim)};`,
    "if (report.mode === 'source-reresolution') report.counts.graphSnapshotDependencyEdges = null;",
    sourceSnapshotDependencyEdges === null
      ? ""
      : `if (report.mode === 'source-reresolution') report.counts.graphSnapshotDependencyEdges = ${JSON.stringify(sourceSnapshotDependencyEdges)};`,
    "if (report.mode === 'restore') report.counts.rosterRecords = 0;",
    failedMode ? "report.status = 'path-unavailable'; report.modeOutcome.success = false; report.modeOutcome.requiredSuccess = false;" : "",
    "if (['full-build', 'coverage', 'restore'].includes(report.mode)) report.modeOutcome.operationReportRecords = report.counts.reportRecords ?? 0;",
    operationReportRecords === null ? "" : `report.modeOutcome.operationReportRecords = ${operationReportRecords};`,
    "report.projectId = projectId;",
    malformed ? "delete report.bytes.payloadBytes;" : "",
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

test("native metric claims require closed connections and exact mode-specific interruption proof", () => {
  const workspace = makeWorkspace();
  const proof = `
    report.process.temporaryBytes = 0;
    report.sql.lifecycleVmStepsUpperBound = 4;
    report.sql.lifecycleVmStepsMethod = 'audited-sqlite-cadence-one-progress-including-prepare-upper-bound';
    report.sql.sqliteSourceId = '2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24';
    report.process.temporaryDisk = {
      logicalHighWaterUpperBoundBytes: 10, initialBytes: 1, successfulWriteBytes: 2,
      sqliteFileGrowthBytes: 3, sqliteShmGrowthBytes: 4, openedFiles: 1, closedFiles: 1,
      method: 'initial-plus-linux-wchar-plus-sqlite-vfs-positive-growth', coverage: 'test', uncertainty: 'test',
    };
    report.interruptionProbes = ['build-prepare', 'build-publish'].flatMap((phase) =>
      ['cancel', 'foreground'].flatMap((kind) => ['first-sql-progress', 'before-commit'].map((triggerPoint) => ({
        phase, kind, triggerPoint, latencyMs: kind === 'cancel' ? 2 : 3, progressCallbacks: 1,
        connectionReusable: true, transactionClean: true, progressHandlerCleared: true,
        busyTimeoutRestored: true, bindingUnchanged: true,
      }))));
    report.cancel = { status: 'measured', latencyMs: 2, scope: 'selected-mode-full-set-owners', method: 'test', uncertainty: 'test' };
    report.occupancy.foregroundWaitMs = 3;
    report.occupancy.foregroundWaitScope = 'selected-mode-full-set-owners';
  `;
  const binary = path.join(workspace.directory, "measurement-child.mjs");
  const install = (mutation) => {
    writeFileSync(binary, childReportSource().replace("console.log(JSON.stringify(report));", `${proof}\n${mutation}\nconsole.log(JSON.stringify(report));`));
    chmodSync(binary, 0o755);
  };
  try {
    install("");
    const valid = JSON.parse(runProbe(workspace, binary, ["--fixture", fixtureId]));
    assert.equal(valid.results[0].summary.medianTemporaryBytes, 0);
    assert.equal(valid.results[0].summary.exactVmSteps, false);
    assert.deepEqual(valid.results[0].summary.vmStepsKinds, ["profiled-subset-lower-bound"]);
    assert.equal(valid.results[0].summary.medianCancelLatencyMs, 2);
    assert.equal(valid.results[0].summary.maxLifecycleVmStepsUpperBound, 4);
    assert.equal(valid.results[0].summary.maxTemporaryDiskHighWaterUpperBoundBytes, 10);
    for (const [mutation, expected] of [
      ["report.sql.closedConnections = 0;", /incomplete connection coverage/],
      ["report.sql.exactVmSteps = true;", /schema mismatch/],
      ["report.sql.lifecycleVmStepsUpperBound = 2;", /SQL upper bound/],
      ["report.sql.sqliteSourceId = 'unreviewed-engine';", /SQL upper bound/],
      ["report.process.temporaryDisk.openedFiles = 2;", /disk upper bound/],
      ["report.process.temporaryDisk.logicalHighWaterUpperBoundBytes = 9;", /disk upper bound/],
      ["report.cancel = { status: 'not-run', latencyMs: 1, scope: null, method: null, uncertainty: null }; report.interruptionProbes = []; report.occupancy.foregroundWaitMs = null; report.notMeasured = [];", /schema mismatch/],
      ["report.cancel.latencyMs = null;", /schema mismatch/],
      ["report.cancel.status = 'unknown';", /schema mismatch/],
      ["delete report.process.temporaryBytesMethod;", /schema mismatch/],
      ["report.interruptionProbes[0].phase = 'coverage-verify';", /interruption phases/],
      ["report.interruptionProbes.pop();", /interruption phases/],
      ["report.interruptionProbes[0].triggerPoint = 'before-commit';", /interruption phases/],
      ["report.interruptionProbes[0].bindingUnchanged = false;", /schema mismatch/],
      ["report.cancel.latencyMs = 0;", /interruption summary/],
      ["report.cancel.scope = 'isolated-whole-project-graph-prepare';", /interruption summary/],
    ]) {
      install(mutation);
      assert.throws(() => runProbe(workspace, binary, ["--fixture", fixtureId]), expected);
      assert.equal(existsSync(path.join(workspace.outputDirectory, "capacity-report.json")), false);
    }
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("capacity manifest fixes the diagnostic matrix and Graph lifecycle boundary", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert.equal(manifest.schemaVersion, "nir1-capacity/1");
  assert.equal(manifest.schema, "schema.v1.json");
  assert.equal(schema.properties.diagnosticOnly.const, true);
  assert.equal(schema.properties.admissionBoundary.properties.currentMaterialLimit.const, 512);
  assert.equal(schema.properties.graphLifecycle.$ref, "#/$defs/graphLifecycle");
  assert.ok(schema.$defs.observationBytes.required.includes("rosterBytes"));
  assert.equal(schema.$defs.observationBytes.properties.rosterSerializedBytes, undefined);
  assert.equal(manifest.graphLifecycle.queryActivation, "not-activated");
  assert.equal(manifest.graphLifecycle.productDispatch, "not-activated");
  assert.equal(manifest.graphLifecycle.supportedCapacityClaim, false);
  assert.equal(manifest.runProtocol.warmupCount, 1);
  assert.ok(manifest.runProtocol.measuredRunCount >= 5);
  assert.equal(manifest.runProtocol.sourceState, "immutable-main-wal-shm");
  assert.equal(manifest.runProtocol.childState, "record-before-and-after");
  assert.ok(manifest.runProtocol.childTimeoutMs > 0);
  assert.ok(manifest.runProtocol.childTerminationGraceMs > 0);
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
  assert.ok(manifest.requiredMetrics.includes("totalPeakRss"));
  assert.ok(manifest.requiredMetrics.includes("rustHeapRequestedHighWater"));
  assert.ok(manifest.requiredMetrics.includes("sqlConnectionCoverage"));
  assert.ok(manifest.requiredMetrics.includes("interruptionPhaseProofs"));
  assert.ok(schema.$defs.observationProcess.required.includes("temporaryBytesMethod"));
  assert.ok(schema.$defs.capacityObservation.required.includes("interruptionProbes"));
  assert.ok(schema.$defs.observationProcess.required.includes("rustHeap"));
  assert.equal(schema.$defs.rustHeapMeasurement.additionalProperties, false);
  assert.ok(schema.$defs.observationCancel.required.includes("uncertainty"));
  assert.ok(schema.$defs.observationOccupancy.required.includes("foregroundWaitScope"));
  assert.equal(manifest.runProtocol.modeIsolation.length > 0, true);
  assert.deepEqual(
    manifest.diagnosticModes.map((mode) => mode.id),
    [
      "source-reresolution",
      "complete-registration",
      "coverage",
      "restore",
      "cold-reopen",
    ],
  );
  for (const mode of manifest.diagnosticModes) {
    assert.deepEqual(mode.fixtures, ["Q8176/R16", "D2064/report-heavy"]);
    assert.equal(typeof mode.producesReportRecords, "boolean");
    assert.equal(mode.minimumOperationReportRecords["D2064/report-heavy"] >= 0, true);
  }
  assert.deepEqual(
    manifest.diagnosticModes.find((mode) => mode.id === "source-reresolution")
      .postOperationShape,
    {
      "Q8176/R16": { graphSnapshotDependencyEdges: null },
      "D2064/report-heavy": { graphSnapshotDependencyEdges: null },
    },
  );
  assert.deepEqual(
    manifest.diagnosticModes.find((mode) => mode.id === "restore")
      .postOperationShape,
    {
      "Q8176/R16": { rosterRecords: 0 },
      "D2064/report-heavy": {
        rosterRecords: 0,
        graphSnapshotDependencyEdges: 1,
      },
    },
  );
  for (const fixture of manifest.fixtures) {
    assert.ok(fixture.shape, `${fixture.id} must declare an observed shape`);
  }
});

test("target fixtures execute every diagnostic mode in isolated child paths", () => {
  const selectedFixture = "Q8176/R16";
  const workspace = makeWorkspace(selectedFixture);
  try {
    const binary = makeChild(workspace.directory, {
      fixtureForReport: selectedFixture,
      enforceSingleChildCopy: true,
    });
    const report = JSON.parse(
      runProbe(workspace, binary, [
        "--fixture",
        selectedFixture,
        "--runs",
        "5",
      ]),
    );
    const result = report.results[0];
    assert.deepEqual(
      result.modeResults.map((modeResult) => modeResult.mode),
      [
        "full-build",
        "source-reresolution",
        "complete-registration",
        "coverage",
        "restore",
        "cold-reopen",
      ],
    );
    assert.equal(result.modeResults.length, 6);
    for (const modeResult of result.modeResults) {
      assert.equal(
        modeResult.fixtureShape.qualifiedMaterials,
        modeResult.fixture.shape.qualifiedMaterials,
      );
      assert.equal(
        modeResult.fixtureShape.qualifiedRevisions,
        modeResult.fixture.shape.qualifiedRevisions,
      );
      assert.equal(
        modeResult.fixtureShape.rosterRecords,
        modeResult.fixture.shape.rosterRecords,
      );
      if (modeResult.mode === "restore") {
        assert.equal(
          modeResult.fixtureShape.rosterRecords,
          8176,
          "Restore fixtureShape must retain the pre-run roster",
        );
        assert.ok(
          modeResult.runs.every((run) => run.counts.rosterRecords === 0),
          "Restore post-operation Graph shape must have an empty roster",
        );
      }
      assert.equal(modeResult.warmup.mode, modeResult.mode);
      assert.equal(modeResult.runs.length, 5);
      assert.equal(modeResult.sourceStateStable, true);
      assert.equal(
        new Set([
          modeResult.warmup.processId,
          ...modeResult.runs.map((run) => run.processId),
        ]).size,
        6,
      );
      assert.ok(
        modeResult.runs.every((run) => run.mode === modeResult.mode),
        `${modeResult.mode} reports must retain their path id`,
      );
      assert.ok(modeResult.runs.every((run) => run.status === "measured"));
      assert.ok(
        modeResult.runs.every(
          (run) =>
            run.modeOutcome.success === true &&
            run.modeOutcome.requiredSuccess === true,
        ),
      );
      assert.ok(
        modeResult.runs.every((run) =>
          run.notMeasured.every((metric) =>
            metric === "cancel-latency" || metric === "publish-transaction-occupancy" || metric.startsWith(`${modeResult.mode}:`),
          ),
        ),
      );
    }
    assert.equal(report.paths.length, 6);
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("probe orchestration keeps fixture-wide and Graph-snapshot edge counts separate", () => {
  const selectedFixture = "Q2044/evidence-shared";
  const workspace = makeWorkspace(selectedFixture);
  try {
    const binary = makeChild(workspace.directory, {
      fixtureForReport: selectedFixture,
    });
    const report = JSON.parse(
      runProbe(workspace, binary, ["--fixture", selectedFixture, "--runs", "5"]),
    );
    const result = report.results[0];
    assert.equal(result.fixtureShape.dependencyEdges, 1028);
    assert.equal(result.fixtureShape.graphSnapshotDependencyEdges, 257);
    for (const modeResult of result.modeResults) {
      assert.equal(modeResult.fixtureShape.dependencyEdges, 1028);
      assert.equal(modeResult.fixtureShape.graphSnapshotDependencyEdges, 257);
      assert.equal(modeResult.warmup.counts.dependencyEdges, 1028);
      assert.equal(modeResult.warmup.counts.graphSnapshotDependencyEdges, 257);
      assert.ok(
        modeResult.runs.every(
          (run) =>
            run.counts.dependencyEdges === 1028 &&
            run.counts.graphSnapshotDependencyEdges === 257,
        ),
        `${modeResult.mode} must preserve both edge metrics`,
      );
    }
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("report-heavy fixture crosses the default mode matrix without requiring fixture reports from every mode", () => {
  const selectedFixture = "D2064/report-heavy";
  const workspace = makeWorkspace(selectedFixture);
  try {
    const binary = makeChild(workspace.directory, {
      fixtureForReport: selectedFixture,
    });
    const report = JSON.parse(
      runProbe(workspace, binary, ["--fixture", selectedFixture, "--runs", "5"]),
    );
    const result = report.results[0];
    assert.equal(result.modeResults.length, 6);
    for (const modeResult of result.modeResults) {
      assert.ok(modeResult.runs.every((run) => run.status === "measured"));
      const produces = ["full-build", "coverage", "restore"].includes(modeResult.mode);
      const expectedSnapshotEdges = modeResult.mode === "source-reresolution" ? null : 1;
      assert.ok(
        modeResult.runs.every((run) =>
          produces
            ? run.modeOutcome.operationReportRecords === 416
            : run.modeOutcome.operationReportRecords === null,
        ),
        `${modeResult.mode} must distinguish fixture reportRecords from operation output`,
      );
      assert.ok(
        modeResult.runs.every(
          (run) => run.counts.graphSnapshotDependencyEdges === expectedSnapshotEdges,
        ),
        `${modeResult.mode} must report its Graph snapshot edge contract`,
      );
    }
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("source re-resolution rejects a Graph snapshot edge when the mode contract requires null", () => {
  for (const observedEdges of [0, 1]) {
    const selectedFixture = "D2064/report-heavy";
    const workspace = makeWorkspace(selectedFixture);
    try {
      const binary = makeChild(workspace.directory, {
        fixtureForReport: selectedFixture,
        sourceSnapshotDependencyEdges: observedEdges,
      });
      assert.throws(
        () =>
          runProbe(workspace, binary, [
            "--fixture",
            selectedFixture,
            "--mode",
            "source-reresolution",
            "--runs",
            "5",
          ]),
        (error) => {
          assert.match(
            error.stderr,
            new RegExp(
              `expected null, observed ${observedEdges}`,
            ),
          );
          return true;
        },
      );
    } finally {
      rmSync(workspace.directory, { recursive: true, force: true });
    }
  }
});

test("raw child identity and supported-capacity claim are validated before normalization", () => {
  for (const options of [
    { omitMode: true, pattern: /reported mode undefined, expected full-build/ },
    { supportedCapacityClaim: true, pattern: /must explicitly report supportedCapacityClaim=false/ },
  ]) {
    const workspace = makeWorkspace();
    try {
      const binary = makeChild(workspace.directory, options);
      assert.throws(
        () => runProbe(workspace, binary, ["--fixture", fixtureId, "--runs", "5"]),
        (error) => {
          assert.match(error.stderr, options.pattern);
          return true;
        },
      );
    } finally {
      rmSync(workspace.directory, { recursive: true, force: true });
    }
  }
});

test("mode outcomes fail closed when a child reports an unavailable path", () => {
  const workspace = makeWorkspace();
  try {
    const binary = makeChild(workspace.directory, { failedMode: true });
    assert.throws(
      () => runProbe(workspace, binary, ["--fixture", fixtureId, "--runs", "5"]),
      (error) => {
        assert.match(error.stderr, /must report status=measured/);
        return true;
      },
    );
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("report-heavy operation reports cannot be zero or undercounted", () => {
  const workspace = makeWorkspace("D2064/report-heavy");
  try {
    const binary = makeChild(workspace.directory, {
      fixtureForReport: "D2064/report-heavy",
      operationReportRecords: 0,
    });
    assert.throws(
      () =>
        runProbe(workspace, binary, [
          "--fixture",
          "D2064/report-heavy",
          "--mode",
          "coverage",
          "--runs",
          "5",
        ]),
      (error) => {
        assert.match(error.stderr, /undercounted operation-produced report records/);
        return true;
      },
    );
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
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

test("a failed rerun removes a prior success artifact", () => {
  const workspace = makeWorkspace();
  try {
    const successfulBinary = makeChild(workspace.directory, {});
    runProbe(workspace, successfulBinary, ["--fixture", fixtureId, "--runs", "5"]);
    const reportPath = path.join(workspace.outputDirectory, "capacity-report.json");
    assert.equal(existsSync(reportPath), true);

    const failingBinary = makeChild(workspace.directory, { mismatch: true });
    assert.throws(
      () => runProbe(workspace, failingBinary, ["--fixture", fixtureId, "--runs", "5"]),
      (error) => {
        assert.match(error.stderr, /shape mismatch for qualified revisions/);
        return true;
      },
    );
    assert.equal(existsSync(reportPath), false);
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("required positional paths reject option tokens without report or child side effects", () => {
  const workspace = makeWorkspace();
  try {
    const binary = makeChild(workspace.directory, { writeProjectMarker: true });
    mkdirSync(workspace.outputDirectory);
    const reportPath = path.join(workspace.outputDirectory, "capacity-report.json");
    writeFileSync(reportPath, "prior-report");
    const childMarker = path.join(workspace.directory, "child-ran");
    const beforeEntries = readdirSync(workspace.directory).sort();
    const invalidPositionals = [
      ["binary", "--binary", manifestPath, workspace.fixtureDirectory, workspace.outputDirectory, childMarker],
      ["manifest", binary, "--manifest", workspace.fixtureDirectory, workspace.outputDirectory, childMarker],
      ["fixture", binary, manifestPath, "--fixture", workspace.outputDirectory, childMarker],
      ["output", binary, manifestPath, workspace.fixtureDirectory, "--output", childMarker],
    ];
    for (const [label, ...args] of invalidPositionals) {
      assert.throws(
        () =>
          execFileSync(process.execPath, [probePath, ...args], {
            cwd: workspace.directory,
            encoding: "utf8",
          }),
        (error) => {
          assert.match(error.stderr, new RegExp(`${label}.*positional argument|usage:`));
          return true;
        },
        `${label} option token should be rejected before side effects`,
      );
      assert.equal(readFileSync(reportPath, "utf8"), "prior-report");
      assert.equal(existsSync(childMarker), false);
      assert.deepEqual(readdirSync(workspace.directory).sort(), beforeEntries);
    }
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [probePath, binary, manifestPath, workspace.fixtureDirectory],
          { cwd: workspace.directory, encoding: "utf8" },
        ),
      (error) => {
        assert.match(error.stderr, /usage:/);
        return true;
      },
    );
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("child timeout is bounded and reports the fixture/run context", () => {
  const workspace = makeWorkspace();
  try {
    const binary = makeChild(workspace.directory, { timeout: true });
    const started = Date.now();
    assert.throws(
      () => runProbe(workspace, binary, ["--fixture", fixtureId, "--runs", "5", "--timeout-ms", "20", "--kill-grace-ms", "40"]),
      (error) => {
        assert.match(error.stderr, /Q513\/R3\/D0 warmup \[full-build\] timed out after 20ms/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 1000, "TERM-resistant child must be bounded by TERM/KILL escalation");
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("inherited child pipes are a terminal lifecycle failure and stay bounded", () => {
  const workspace = makeWorkspace();
  try {
    const binary = makeChild(workspace.directory, { leakyDescendant: true });
    const started = Date.now();
    assert.throws(
      () => runProbe(workspace, binary, ["--fixture", fixtureId, "--runs", "5", "--timeout-ms", "100", "--kill-grace-ms", "40"]),
      (error) => {
        assert.match(error.stderr, /lifecycle failure: .*output streams did not close/);
        assert.equal(existsSync(path.join(workspace.outputDirectory, "capacity-report.json")), false);
        return true;
      },
    );
    assert.ok(Date.now() - started < 1000, "inherited pipes must not extend the owner beyond its bound");
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("setsid descendants are killed and absent before the owner returns", () => {
  if (process.platform !== "linux") return;
  const workspace = makeWorkspace();
  try {
    const descendantPidPath = path.join(workspace.directory, "descendant.pid");
    const binary = makeChild(workspace.directory, { detachedDescendant: true });
    const started = Date.now();
    assert.throws(
      () =>
        runProbe(workspace, binary, [
          descendantPidPath,
          "--fixture",
          fixtureId,
          "--runs",
          "5",
          "--timeout-ms",
          "100",
          "--kill-grace-ms",
          "40",
        ]),
      (error) => {
        assert.match(error.stderr, /lifecycle failure:/);
        assert.equal(existsSync(path.join(workspace.outputDirectory, "capacity-report.json")), false);
        return true;
      },
    );
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.ok(Date.now() - started < 1000, "setsid descendants must remain bounded");
    assert.equal(existsSync(`/proc/${descendantPid}`), false);
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

test("complete capacity observation schema rejects missing child measurements", () => {
  const workspace = makeWorkspace();
  try {
    const binary = makeChild(workspace.directory, { malformed: true });
    assert.throws(
      () => runProbe(workspace, binary, ["--fixture", fixtureId, "--runs", "5"]),
      (error) => {
        assert.match(error.stderr, /capacity observation schema mismatch/);
        assert.match(error.stderr, /bytes must have required property 'payloadBytes'/);
        return true;
      },
    );
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("shared and unique evidence/dependency shapes are independently checked", () => {
  for (const [selectedFixture, mismatchField, label] of [
    ["Q2044/evidence-shared", "evidenceRecords", "evidence records"],
    ["Q2044/evidence-unique", "dependencyEdges", "dependency edges"],
    [
      "Q2044/evidence-shared",
      "graphSnapshotDependencyEdges",
      "Graph snapshot dependency edges",
    ],
  ]) {
    const workspace = makeWorkspace(selectedFixture);
    try {
      const binary = makeChild(workspace.directory, {
        fixtureForReport: selectedFixture,
        mismatchField,
      });
      assert.throws(
        () => runProbe(workspace, binary, ["--fixture", selectedFixture, "--runs", "5"]),
        (error) => {
          assert.match(error.stderr, new RegExp(`shape mismatch for ${label}`));
          return true;
        },
      );
    } finally {
      rmSync(workspace.directory, { recursive: true, force: true });
    }
  }
});

test("report-heavy Verify report shape is checked independently", () => {
  const selectedFixture = "D2064/report-heavy";
  const workspace = makeWorkspace(selectedFixture);
  try {
    const binary = makeChild(workspace.directory, {
      fixtureForReport: selectedFixture,
      fixtureShapeReportRecords: 415,
    });
    assert.throws(
      () => runProbe(workspace, binary, ["--fixture", selectedFixture, "--runs", "5"]),
      (error) => {
        assert.match(error.stderr, /shape mismatch for report records/);
        return true;
      },
    );
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
});
