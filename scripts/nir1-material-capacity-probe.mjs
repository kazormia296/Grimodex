// Diagnostic-only NIR-1 B capacity orchestrator.
//
// The input fixture databases are prepared elsewhere. This driver never
// mutates them: every warmup and measured sample receives a fresh copy and a
// fresh Native child process. A result is an observation, not a capacity
// approval or a Graph/product activation receipt.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const [binary, manifestPath, fixtureDirectory, outputDirectory] = args;
assert.ok(
  binary && manifestPath && fixtureDirectory && outputDirectory,
  "usage: node scripts/nir1-material-capacity-probe.mjs <binary> <manifest> <fixture-directory> <output-directory> [project-id] [--fixture <id>] [--runs <n>]",
);
const projectId = args.find((value, index) => index >= 4 && !value.startsWith("--"));
const fixtureFilterIndex = args.indexOf("--fixture");
const fixtureFilter =
  fixtureFilterIndex === -1 ? null : args[fixtureFilterIndex + 1];
const runsIndex = args.indexOf("--runs");
const measuredRuns = runsIndex === -1 ? 5 : Number(args[runsIndex + 1]);
assert.ok(Number.isInteger(measuredRuns) && measuredRuns >= 5, "--runs must be an integer >= 5");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.diagnosticOnly, true);
assert.equal(manifest.schemaVersion, "nir1-capacity/1");
assert.equal(manifest.runProtocol.warmupCount, 1);
assert.ok(manifest.runProtocol.measuredRunCount >= 5);
const fixtureSpecs = fixtureFilter
  ? manifest.fixtures.filter((fixture) => fixture.id === fixtureFilter)
  : manifest.fixtures;
assert.ok(fixtureSpecs.length > 0, "fixture not found: " + (fixtureFilter ?? "<none>"));

const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const manifestDigest = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
const scratch = mkdtempSync(path.join(tmpdir(), "nir1-capacity-probe-"));
mkdirSync(outputDirectory, { recursive: true });

function fixturePath(spec) {
  const encoded = spec.id.replaceAll("/", "__");
  const candidates = [
    path.join(fixtureDirectory, encoded + ".db"),
    path.join(fixtureDirectory, spec.id, "grimodex.db"),
  ];
  const existing = candidates.find((candidate) => {
    try {
      readFileSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(
    existing,
    "missing preseeded file-backed DB for " +
      spec.id +
      "; expected " +
      candidates.join(" or "),
  );
  return existing;
}

function runChild(spec, sourceDb, index, warmup) {
  const suffix = warmup ? "warmup" : "run-" + index;
  const copy = path.join(
    scratch,
    spec.id.replaceAll("/", "__") + "-" + suffix + ".db",
  );
  copyFileSync(sourceDb, copy);
  const before = hash(copy);
  const childArgs = [copy, spec.id];
  if (projectId) childArgs.push(projectId);
  const child = spawnSync(path.resolve(binary), childArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    child.status,
    0,
    spec.id + " " + (warmup ? "warmup" : "run " + index) + " failed: " + child.stderr,
  );
  const report = JSON.parse(child.stdout);
  assert.equal(report.diagnosticOnly, true);
  assert.equal(report.fixtureId, spec.id);
  assert.equal(hash(copy), before, "diagnostic child must not write its DB");
  return report;
}

function summarize(reports) {
  const values = (selector) =>
    reports
      .map(selector)
      .filter((value) => typeof value === "number" && Number.isFinite(value))
      .sort((left, right) => left - right);
  const median = (items) =>
    items.length === 0
      ? null
      : items.length % 2 === 0
        ? (items[items.length / 2 - 1] + items[items.length / 2]) / 2
        : items[Math.floor(items.length / 2)];
  const elapsed = values((report) => report.process.elapsedMs);
  const peakRss = values(
    (report) =>
      report.process.hwmRssBytes ?? report.process.ruMaxrssBytes ?? null,
  );
  const vmSteps = values((report) => report.sql.statementVmSteps);
  return {
    measuredRunCount: reports.length,
    medianElapsedMs: median(elapsed),
    maxElapsedMs: elapsed.at(-1) ?? null,
    medianPeakRssBytes: median(peakRss),
    maxPeakRssBytes: peakRss.at(-1) ?? null,
    medianStatementVmSteps: median(vmSteps),
    maxStatementVmSteps: vmSteps.at(-1) ?? null,
  };
}

const results = [];
try {
  for (const spec of fixtureSpecs) {
    const sourceDb = fixturePath(spec);
    const sourceDigest = hash(sourceDb);
    const warmup = runChild(spec, sourceDb, 0, true);
    const reports = [];
    for (let index = 1; index <= measuredRuns; index += 1)
      reports.push(runChild(spec, sourceDb, index, false));
    assert.equal(hash(sourceDb), sourceDigest);
    results.push({
      fixture: spec,
      sourceDatabaseDigest: sourceDigest,
      warmup,
      runs: reports,
      summary: summarize(reports),
      diagnosticOnly: true,
      supportedCapacityClaim: false,
      notMeasured: [
        ...new Set(reports.flatMap((report) => report.notMeasured ?? [])),
      ],
    });
  }
  const report = {
    diagnosticOnly: true,
    schemaVersion: "nir1-capacity-report/1",
    manifestDigest,
    protocol: manifest.runProtocol,
    capacityDecision: "unratified",
    graphQueryActivation: "not-activated",
    productDispatch: "not-activated",
    results,
  };
  writeFileSync(
    path.join(outputDirectory, "capacity-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
