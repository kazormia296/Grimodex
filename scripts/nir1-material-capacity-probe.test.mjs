import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

test("capacity manifest fixes the exact diagnostic fixture matrix", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert.equal(manifest.schemaVersion, "nir1-capacity/1");
  assert.equal(manifest.schema, "schema.v1.json");
  assert.equal(schema.properties.diagnosticOnly.const, true);
  assert.equal(schema.properties.admissionBoundary.properties.currentMaterialLimit.const, 512);
  assert.ok(schema.properties.requiredMetrics.minItems > 0);
  assert.equal(manifest.diagnosticOnly, true);
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
  assert.equal(manifest.runProtocol.warmupCount, 1);
  assert.ok(manifest.runProtocol.measuredRunCount >= 5);
  assert.equal(
    manifest.capacityDecision,
    "unratified-until-all-major-structures-are-measured",
  );
  for (const fixture of manifest.fixtures) {
    const qualified = fixture.id.match(/^Q(\d+)/)?.[1];
    if (qualified !== undefined)
      assert.equal(fixture.qualifiedMaterials, Number(qualified));
    assert.ok(
      fixture.qualifiedMaterials === null ||
        fixture.qualifiedMaterials ===
          Number(fixture.id.match(/^Q(\d+)/)?.[1]),
    );
  }
  assert.ok(manifest.requiredMetrics.includes("temporaryBytes"));
  assert.ok(manifest.requiredMetrics.includes("cancelLatency"));
});

test("orchestrator copies a fixture for every run and starts fresh children", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "nir1-capacity-script-test-"),
  );
  const fixtureDirectory = path.join(directory, "fixtures");
  const outputDirectory = path.join(directory, "output");
  const fakeBinary = path.join(directory, "fake-capacity-child.mjs");
  const fixtureId = "Q513/R3/D0";
  const encoded = fixtureId.replaceAll("/", "__");
  const sourceDb = path.join(fixtureDirectory, encoded + ".db");
  const childSource = [
    "#!/usr/bin/env node",
    "const fixtureId = process.argv[3];",
    "console.log(JSON.stringify({",
    "  diagnosticOnly: true,",
    "  supportedCapacityClaim: false,",
    "  processId: process.pid,",
    "  fixtureId,",
    "  status: 'current-admission-limit',",
    "  process: { elapsedMs: 1, hwmRssBytes: 2, ruMaxrssBytes: 2 },",
    "  sql: { statementVmSteps: 3 },",
    "  notMeasured: ['cancel-latency', 'publish-transaction-occupancy']",
    "}));",
  ].join("\n");
  mkdirSync(fixtureDirectory);
  writeFileSync(sourceDb, "preseeded-file-backed-db");
  writeFileSync(fakeBinary, childSource);
  chmodSync(fakeBinary, 0o755);
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        probePath,
        fakeBinary,
        manifestPath,
        fixtureDirectory,
        outputDirectory,
        "--fixture",
        fixtureId,
        "--runs",
        "5",
      ],
      { encoding: "utf8" },
    ),
  );
  const result = report.results[0];
  assert.equal(report.diagnosticOnly, true);
  assert.equal(result.runs.length, 5);
  const processIds = [
    result.warmup.processId,
    ...result.runs.map((run) => run.processId),
  ];
  assert.equal(new Set(processIds).size, 6);
  assert.equal(result.notMeasured.includes("cancel-latency"), true);
  assert.equal(readFileSync(sourceDb, "utf8"), "preseeded-file-backed-db");
  assert.equal(
    readFileSync(path.join(outputDirectory, "capacity-report.json")).length > 0,
    true,
  );
});
