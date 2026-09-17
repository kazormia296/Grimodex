// Diagnostic-only NIR-1 B capacity orchestrator.
//
// Fixture databases are prepared elsewhere. This driver keeps the preseeded
// main/WAL/SHM source immutable, gives every warmup and measured sample a
// fresh copy and a fresh child process, and records child state transitions.
// A result is an observation, not a capacity approval or a Graph/product
// activation receipt.
import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const USAGE =
  "usage: node scripts/nir1-material-capacity-probe.mjs <binary> <manifest> <fixture-directory> <output-directory> [project-id] [--fixture <id>] [--runs <n>] [--timeout-ms <n>] [--kill-grace-ms <n>]";
const SOURCE_COMPONENTS = [
  ["main", ""],
  ["wal", "-wal"],
  ["shm", "-shm"],
];

function fail(message) {
  throw new Error(message);
}

function parsePositiveInteger(value, label, minimum = 1) {
  if (!/^\d+$/.test(String(value))) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseCli(argv) {
  if (argv.length < 4) fail(USAGE);
  const [binary, manifestPath, fixtureDirectory, outputDirectory] = argv;
  const options = {
    binary,
    manifestPath,
    fixtureDirectory,
    outputDirectory,
    projectId: null,
    fixtureFilter: null,
    measuredRuns: null,
    timeoutMs: null,
    terminationGraceMs: null,
  };
  for (let index = 4; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixture") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--"))
        fail("--fixture requires a fixture id");
      options.fixtureFilter = argv[++index];
      continue;
    }
    if (value === "--runs") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--"))
        fail("--runs requires a count");
      options.measuredRuns = parsePositiveInteger(argv[++index], "--runs", 5);
      if (options.measuredRuns < 5) fail("--runs must be an integer >= 5");
      continue;
    }
    if (value === "--timeout-ms" || value === "--timeout") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--"))
        fail(`${value} requires a timeout in milliseconds`);
      options.timeoutMs = parsePositiveInteger(argv[++index], value);
      continue;
    }
    if (value === "--kill-grace-ms" || value === "--termination-grace-ms") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--"))
        fail(`${value} requires a termination grace period in milliseconds`);
      options.terminationGraceMs = parsePositiveInteger(
        argv[++index],
        value,
      );
      continue;
    }
    if (value === "--project-id") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--"))
        fail("--project-id requires a project id");
      if (options.projectId !== null) fail("project id was provided more than once");
      options.projectId = argv[++index];
      continue;
    }
    if (value.startsWith("--")) {
      fail(`unknown option: ${value}`);
    }
    if (options.projectId !== null) {
      fail(`unexpected positional argument: ${value}`);
    }
    // Only unconsumed positional values reach this branch. In particular,
    // --fixture/--runs/--timeout-ms values are consumed above and can never
    // become a project id by accident.
    options.projectId = value;
  }
  return options;
}

function readJson(file, label) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`unable to read ${label} ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON in ${label} ${file}: ${error.message}`);
  }
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

function validateManifest(manifest, manifestPath) {
  if (typeof manifest.schema !== "string" || manifest.schema.length === 0) {
    fail(`manifest ${manifestPath} does not name its JSON schema`);
  }
  const schemaPath = path.resolve(path.dirname(manifestPath), manifest.schema);
  const schema = readJson(schemaPath, "manifest schema");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  let validate;
  let validateObservation;
  try {
    validate = ajv.compile(schema);
    validateObservation = ajv.compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      $ref: "#/$defs/capacityObservation",
    });
  } catch (error) {
    fail(`manifest schema ${schemaPath} is invalid: ${error.message}`);
  }
  if (!validate(manifest)) {
    fail(`manifest ${manifestPath} failed JSON schema validation: ${formatAjvErrors(validate.errors)}`);
  }
  return { schema, schemaPath, validateObservation };
}

function assertManifestRuntimeContract(manifest, manifestPath) {
  if (manifest.diagnosticOnly !== true) {
    fail(`manifest ${manifestPath} must be diagnosticOnly=true`);
  }
  if (manifest.schemaVersion !== "nir1-capacity/1") {
    fail(`manifest ${manifestPath} has unsupported schemaVersion ${String(manifest.schemaVersion)}`);
  }
  if (manifest.runProtocol?.warmupCount !== 1) {
    fail(`manifest ${manifestPath} must configure exactly one warmup run`);
  }
  if (
    !Number.isSafeInteger(manifest.runProtocol?.measuredRunCount) ||
    manifest.runProtocol.measuredRunCount < 5
  ) {
    fail(`manifest ${manifestPath} must configure at least five measured runs`);
  }
  if (
    manifest.runProtocol?.freshCopyPerRun !== true ||
    manifest.runProtocol?.freshProcessPerRun !== true
  ) {
    fail(`manifest ${manifestPath} must use a fresh copy and process for every run`);
  }
  if (
    !Number.isSafeInteger(manifest.runProtocol?.childTerminationGraceMs) ||
    manifest.runProtocol.childTerminationGraceMs < 1
  ) {
    fail(`manifest ${manifestPath} must configure a positive child termination grace period`);
  }
  if (
    manifest.graphLifecycle?.queryActivation !== "not-activated" ||
    manifest.graphLifecycle?.productDispatch !== "not-activated" ||
    manifest.graphLifecycle?.supportedCapacityClaim !== false
  ) {
    fail(`manifest ${manifestPath} must keep Graph/product activation disabled`);
  }
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function componentPath(databasePath, suffix) {
  return `${databasePath}${suffix}`;
}

function captureComponent(databasePath, name, suffix) {
  const file = componentPath(databasePath, suffix);
  try {
    const bytes = readFileSync(file);
    return {
      name,
      path: file,
      present: true,
      bytes: bytes.length,
      digest: hashBytes(bytes),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { name, path: file, present: false, bytes: 0, digest: null };
    }
    fail(`unable to snapshot ${name} database state ${file}: ${error.message}`);
  }
}

function captureDatabaseState(databasePath) {
  const components = Object.fromEntries(
    SOURCE_COMPONENTS.map(([name, suffix]) => [
      name,
      captureComponent(databasePath, name, suffix),
    ]),
  );
  const digest = createHash("sha256");
  for (const [name, suffix] of SOURCE_COMPONENTS) {
    const component = components[name];
    digest.update(`${name}\0${component.present ? "present" : "absent"}\0`);
    if (component.present) {
      digest.update(readFileSync(componentPath(databasePath, suffix)));
    }
  }
  return { digest: digest.digest("hex"), ...components };
}

function comparableDatabaseState(state) {
  return {
    digest: state.digest,
    main: {
      present: state.main.present,
      bytes: state.main.bytes,
      digest: state.main.digest,
    },
    wal: {
      present: state.wal.present,
      bytes: state.wal.bytes,
      digest: state.wal.digest,
    },
    shm: {
      present: state.shm.present,
      bytes: state.shm.bytes,
      digest: state.shm.digest,
    },
  };
}

function assertSourceStable(sourcePath, expectedState, context) {
  const actualState = captureDatabaseState(sourcePath);
  if (
    JSON.stringify(comparableDatabaseState(actualState)) !==
    JSON.stringify(comparableDatabaseState(expectedState))
  ) {
    fail(
      `immutable preseed source changed during ${context}: ${sourcePath} ` +
        `(main/WAL/SHM digest before ${expectedState.digest}, after ${actualState.digest})`,
    );
  }
}

function copyPreseedState(sourcePath, childPath) {
  copyFileSync(sourcePath, childPath);
  for (const [, suffix] of SOURCE_COMPONENTS.slice(1)) {
    const sourceSidecar = componentPath(sourcePath, suffix);
    const childSidecar = componentPath(childPath, suffix);
    if (existsSync(sourceSidecar)) {
      copyFileSync(sourceSidecar, childSidecar);
    } else {
      rmSync(childSidecar, { force: true });
    }
  }
}

function fixturePath(spec, fixtureDirectory) {
  const encoded = spec.id.replaceAll("/", "__");
  const candidates = [
    path.join(fixtureDirectory, encoded + ".db"),
    path.join(fixtureDirectory, spec.id, "grimodex.db"),
  ];
  const existing = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!existing) {
    fail(
      `missing preseeded file-backed DB for ${spec.id}; expected ${candidates.join(" or ")}`,
    );
  }
  return existing;
}

function valueAt(object, parts) {
  let value = object;
  for (const part of parts) {
    if (value === null || typeof value !== "object" || !(part in value)) {
      return undefined;
    }
    value = value[part];
  }
  return value;
}

function firstValue(object, paths) {
  for (const parts of paths) {
    const value = valueAt(object, parts);
    if (value !== undefined) return value;
  }
  return undefined;
}

const OBSERVED_SHAPE_PATHS = {
  candidateRevisions: [
    ["counts", "candidateRevisions"],
    ["counts", "candidateRevisionCount"],
    ["candidateRevisions"],
    ["candidateRevisionCount"],
  ],
  qualifiedRevisions: [
    ["counts", "qualifiedRevisions"],
    ["counts", "qualifiedRevisionCount"],
    ["qualifiedRevisions"],
    ["qualifiedRevisionCount"],
  ],
  qualifiedMaterials: [
    ["counts", "qualifiedMaterialRecords"],
    ["counts", "qualifiedMaterials"],
    ["qualifiedMaterialRecords"],
    ["qualifiedMaterials"],
  ],
  ineligibleCandidates: [
    ["counts", "rejectedRevisions"],
    ["counts", "ineligibleCandidates"],
    ["rejectedRevisions"],
    ["ineligibleCandidates"],
  ],
  rosterRecords: [
    ["counts", "rosterRecords"],
    ["counts", "rosterRecordCount"],
    ["rosterRecords"],
    ["rosterRecordCount"],
  ],
  evidenceRecords: [
    ["counts", "evidenceRecords"],
    ["counts", "evidenceRecordCount"],
    ["evidenceRecords"],
    ["evidenceRecordCount"],
  ],
  dependencyEdges: [
    ["counts", "dependencyEdges"],
    ["counts", "dependencyEdgeCount"],
    ["dependencyEdges"],
    ["dependencyEdgeCount"],
  ],
  reportRecords: [
    ["counts", "reportRecords"],
    ["counts", "reportRecordCount"],
    ["reportRecords"],
    ["reportRecordCount"],
  ],
};

function expectedShape(spec) {
  const shape = {
    ...(spec.shape ?? {}),
    ...(spec.observedShape ?? {}),
  };
  const legacy = {
    qualifiedMaterials: spec.qualifiedMaterials,
    qualifiedRevisions: spec.qualifiedRevisions,
    ineligibleCandidates: spec.ineligibleCandidates,
  };
  for (const [key, value] of Object.entries(legacy)) {
    if (shape[key] === undefined) shape[key] = value;
  }
  if (
    shape.qualifiedMaterialRecords === undefined &&
    shape.qualifiedMaterials !== undefined
  ) {
    shape.qualifiedMaterialRecords = shape.qualifiedMaterials;
  }
  if (
    shape.rejectedRevisions === undefined &&
    shape.ineligibleCandidates !== undefined
  ) {
    shape.rejectedRevisions = shape.ineligibleCandidates;
  }
  if (
    shape.candidateRevisions === undefined &&
    shape.qualifiedRevisions !== null &&
    shape.qualifiedRevisions !== undefined &&
    shape.ineligibleCandidates !== null &&
    shape.ineligibleCandidates !== undefined
  ) {
    shape.candidateRevisions =
      shape.qualifiedRevisions + shape.ineligibleCandidates;
  }
  return shape;
}

function validateObservedShape(report, spec, context) {
  const shape = expectedShape(spec);
  const labels = {
    qualifiedMaterials: "qualified material records",
    qualifiedMaterialRecords: "qualified material records",
    ineligibleCandidates: "ineligible/rejected candidates",
    rejectedRevisions: "ineligible/rejected candidates",
    candidateRevisions: "candidate revisions",
    qualifiedRevisions: "qualified revisions",
    rosterRecords: "roster records",
    evidenceRecords: "evidence records",
    dependencyEdges: "dependency edges",
    reportRecords: "report records",
  };
  const aliases = {
    qualifiedMaterialRecords: "qualifiedMaterials",
    rejectedRevisions: "ineligibleCandidates",
  };
  const checked = new Set();
  for (const [key, expected] of Object.entries(shape)) {
    if (expected === null || expected === undefined) continue;
    const canonicalKey = aliases[key] ?? key;
    if (checked.has(canonicalKey)) continue;
    checked.add(canonicalKey);
    const observed = firstValue(report, OBSERVED_SHAPE_PATHS[canonicalKey] ?? []);
    if (
      !Number.isSafeInteger(expected) ||
      typeof observed !== "number" ||
      !Number.isSafeInteger(observed) ||
      observed !== expected
    ) {
      const observedLabel = observed === undefined ? "missing" : String(observed);
      fail(
        `${context} shape mismatch for ${labels[key] ?? key}: expected ${expected}, observed ${observedLabel}`,
      );
    }
  }
}

function assertDiagnosticReport(report, spec, context, validateObservation) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail(`${context} did not emit a JSON object`);
  }
  if (report.diagnosticOnly !== true) {
    fail(`${context} must report diagnosticOnly=true`);
  }
  if (report.fixtureId !== spec.id) {
    fail(`${context} reported fixtureId ${String(report.fixtureId)}, expected ${spec.id}`);
  }
  if (
    report.supportedCapacityClaim !== undefined &&
    report.supportedCapacityClaim !== false
  ) {
    fail(`${context} attempted to claim supported capacity`);
  }
  if (report.notMeasured !== undefined) {
    if (
      !Array.isArray(report.notMeasured) ||
      report.notMeasured.some((value) => typeof value !== "string")
    ) {
      fail(`${context} notMeasured must be an array of strings`);
    }
  }
  if (report.graphLifecycle?.activated === true) {
    fail(`${context} activated Graph lifecycle during diagnostic measurement`);
  }
  if (
    report.graphLifecycle?.queryActivation !== undefined &&
    report.graphLifecycle.queryActivation !== "not-activated"
  ) {
    fail(`${context} reported Graph query activation`);
  }
  if (
    report.graphLifecycle?.productDispatch !== undefined &&
    report.graphLifecycle.productDispatch !== "not-activated"
  ) {
    fail(`${context} reported product dispatch activation`);
  }
  if (!validateObservation(report)) {
    fail(
      `${context} capacity observation schema mismatch: ${formatAjvErrors(validateObservation.errors)}`,
    );
  }
  validateObservedShape(report, spec, context);
}

function generationValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  if (typeof value === "string" && value.trim().length > 0) return value;
  return null;
}

function publishedGeneration(report, phase) {
  const phaseKey = phase === "before" ? "publishedGenerationBefore" : "publishedGenerationAfter";
  const paths =
    phase === "before"
      ? [
          ["publishedGeneration", "before"],
          [phaseKey],
          ["publication", "publishedGeneration", "before"],
          ["publication", phaseKey],
          ["graphLifecycle", phaseKey],
          ["graphLifecycle", "publishedGeneration", "before"],
          ["graphLifecycle", "before", "publishedGeneration"],
          ["publication", "before", "publishedGeneration"],
        ]
      : [
          ["publishedGeneration", "after"],
          [phaseKey],
          ["publishedGeneration"],
          ["publication", "publishedGeneration", "after"],
          ["publication", phaseKey],
          ["publication", "publishedGeneration"],
          ["graphLifecycle", phaseKey],
          ["graphLifecycle", "publishedGeneration", "after"],
          ["graphLifecycle", "publishedGeneration"],
          ["graphLifecycle", "after", "publishedGeneration"],
          ["publication", "after", "publishedGeneration"],
          ["terminalReceipt", "publishedGeneration"],
        ];
  return generationValue(firstValue(report, paths));
}

function safeChildName(specId, suffix) {
  const encoded = specId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${encoded}-${suffix}.db`;
}

function spawnChildProcess(binary, childArgs, context, timeoutMs, terminationGraceMs) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let exitInfo = null;
    let streamsClosed = false;
    let timedOut = false;
    let termSent = false;
    let killSent = false;
    let settled = false;
    let timeoutTimer = null;
    let termTimer = null;
    let killTimer = null;
    let streamTimer = null;

    const clearTimers = () => {
      for (const timer of [timeoutTimer, termTimer, killTimer, streamTimer]) {
        if (timer !== null) clearTimeout(timer);
      }
      timeoutTimer = null;
      termTimer = null;
      killTimer = null;
      streamTimer = null;
    };

    const finish = (result = {}) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        status: exitInfo?.status ?? null,
        signal: exitInfo?.signal ?? null,
        stdout,
        stderr,
        timedOut,
        exitConfirmed: exitInfo !== null,
        termination: {
          termSent,
          killSent,
          exitConfirmed: exitInfo !== null,
        },
        ...result,
      });
    };

    const sendSignal = (signal) => {
      try {
        return child?.kill(signal) === true;
      } catch (error) {
        stderr += `\nfailed to send ${signal}: ${error.message}`;
        return false;
      }
    };

    const finishAfterExit = () => {
      if (exitInfo === null) return;
      if (streamsClosed) {
        finish();
        return;
      }
      if (streamTimer === null) {
        streamTimer = setTimeout(() => {
          finish({
            lifecycleError: new Error(
              `${context} exited but its output streams did not close within ${terminationGraceMs}ms`,
            ),
          });
        }, terminationGraceMs);
      }
    };

    try {
      child = spawn(path.resolve(binary), childArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({ error });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      // ENOENT and equivalent spawn failures have no running child to reap.
      // If an exit was already observed, retain that proof and report the
      // lifecycle error after streams close.
      if (exitInfo === null) {
        finish({ error });
      } else {
        finishAfterExit();
      }
    });
    child.once("exit", (status, signal) => {
      exitInfo = { status, signal };
      finishAfterExit();
    });
    child.once("close", (status, signal) => {
      streamsClosed = true;
      if (exitInfo === null) exitInfo = { status, signal };
      finishAfterExit();
    });

    timeoutTimer = setTimeout(() => {
      if (settled || exitInfo !== null) return;
      timedOut = true;
      termSent = sendSignal("SIGTERM");
      termTimer = setTimeout(() => {
        if (settled || exitInfo !== null) return;
        killSent = sendSignal("SIGKILL");
        killTimer = setTimeout(() => {
          if (settled || exitInfo !== null) return;
          finish({
            lifecycleError: new Error(
              `${context} did not exit after SIGKILL within ${terminationGraceMs}ms`,
            ),
          });
        }, terminationGraceMs);
      }, terminationGraceMs);
    }, timeoutMs);
  });
}

function childFailureMessage(child, context, binary, timeoutMs) {
  if (child.error?.code === "ETIMEDOUT" || child.timedOut) {
    return `${context} timed out after ${timeoutMs}ms (binary ${binary})`;
  }
  if (child.lifecycleError) {
    return `${context} lifecycle failure: ${child.lifecycleError.message}`;
  }
  if (child.error) return `${context} could not start: ${child.error.message}`;
  const status = child.status === null ? "no exit status" : `exit status ${child.status}`;
  const signal = child.signal ? `, signal ${child.signal}` : "";
  const stderr = String(child.stderr ?? "").trim();
  return `${context} failed (${status}${signal})${stderr ? `: ${stderr}` : ""}`;
}

function parseChildJson(stdout, context) {
  const text = String(stdout ?? "").trim();
  if (!text) fail(`${context} emitted no JSON report`);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${context} emitted invalid JSON: ${error.message}`);
  }
}

async function runChild({
  binary,
  projectId,
  spec,
  sourceDb,
  sourceState,
  scratch,
  index,
  warmup,
  timeoutMs,
  terminationGraceMs,
  validateObservation,
}) {
  const runLabel = warmup ? "warmup" : `run ${index}`;
  const context = `${spec.id} ${runLabel}`;
  const childPath = path.join(
    scratch,
    safeChildName(spec.id, warmup ? "warmup" : `run-${index}`),
  );
  copyPreseedState(sourceDb, childPath);
  const before = captureDatabaseState(childPath);
  const childArgs = [childPath, spec.id];
  if (projectId !== null) childArgs.push(projectId);
  let child = null;
  let after;
  try {
    child = await spawnChildProcess(
      binary,
      childArgs,
      context,
      timeoutMs,
      terminationGraceMs,
    );
  } finally {
    // The child owner resolves only after exit confirmation (or after the
    // bounded SIGKILL escalation reports that confirmation is unavailable).
    // Snapshot and source verification run on every path before scratch
    // cleanup so a mutable child can never be mistaken for a stable source.
    after = captureDatabaseState(childPath);
    assertSourceStable(sourceDb, sourceState, context);
  }
  if (
    !child ||
    child.error ||
    child.status !== 0 ||
    child.signal !== null ||
    child.timedOut ||
    child.exitConfirmed !== true
  ) {
    fail(
      childFailureMessage(
        child ?? {
          lifecycleError: new Error("child owner did not return a lifecycle result"),
        },
        context,
        binary,
        timeoutMs,
      ),
    );
  }
  const rawReport = parseChildJson(child.stdout, context);
  assertDiagnosticReport(rawReport, spec, context, validateObservation);
  const report = {
    ...rawReport,
    supportedCapacityClaim: false,
    notMeasured: rawReport.notMeasured ?? [],
  };
  const generationBefore = publishedGeneration(rawReport, "before");
  const generationAfter = publishedGeneration(rawReport, "after");
  const childState = {
    before,
    after,
    digestBefore: before.digest,
    digestAfter: after.digest,
    publishedGenerationBefore: generationBefore,
    publishedGenerationAfter: generationAfter,
    publishedGeneration: generationAfter,
  };
  return {
    ...report,
    runKind: warmup ? "warmup" : "measured",
    runIndex: warmup ? 0 : index,
    childState,
    childDatabaseDigestBefore: before.digest,
    childDatabaseDigestAfter: after.digest,
    childDigestBefore: before.digest,
    childDigestAfter: after.digest,
    publishedGenerationBefore: generationBefore,
    publishedGenerationAfter: generationAfter,
  };
}

function numericValues(reports, selector) {
  return reports
    .map(selector)
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
}

function summarize(reports) {
  const median = (items) =>
    items.length === 0
      ? null
      : items.length % 2 === 0
        ? (items[items.length / 2 - 1] + items[items.length / 2]) / 2
        : items[Math.floor(items.length / 2)];
  const elapsed = numericValues(reports, (report) => report.process?.elapsedMs);
  const peakRss = numericValues(
    reports,
    (report) =>
      report.process?.hwmRssBytes ??
      report.process?.ruMaxrssBytes ??
      report.process?.rssBytes ??
      null,
  );
  const vmSteps = numericValues(
    reports,
    (report) => report.sql?.statementVmSteps,
  );
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

function uniqueNotMeasured(reports) {
  return [
    ...new Set(
      reports.flatMap((report) =>
        Array.isArray(report.notMeasured) ? report.notMeasured : [],
      ),
    ),
  ];
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const manifestPath = path.resolve(options.manifestPath);
  const manifest = readJson(manifestPath, "manifest");
  const { validateObservation } = validateManifest(manifest, manifestPath);
  assertManifestRuntimeContract(manifest, manifestPath);
  const measuredRuns = options.measuredRuns ?? manifest.runProtocol.measuredRunCount;
  if (!Number.isSafeInteger(measuredRuns) || measuredRuns < 5) {
    fail("manifest runProtocol.measuredRunCount and --runs must be integers >= 5");
  }
  const timeoutMs = options.timeoutMs ?? manifest.runProtocol.childTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail("manifest runProtocol.childTimeoutMs and --timeout-ms must be positive integers");
  }
  const terminationGraceMs =
    options.terminationGraceMs ?? manifest.runProtocol.childTerminationGraceMs;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    fail(
      "manifest runProtocol.childTerminationGraceMs and --kill-grace-ms must be positive integers",
    );
  }
  const fixtureSpecs = options.fixtureFilter
    ? manifest.fixtures.filter((fixture) => fixture.id === options.fixtureFilter)
    : manifest.fixtures;
  if (fixtureSpecs.length === 0) {
    fail(`fixture not found: ${options.fixtureFilter ?? "<none>"}`);
  }
  const fixtureDirectory = path.resolve(options.fixtureDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  const manifestDigest = hashBytes(Buffer.from(JSON.stringify(manifest)));
  const scratch = mkdtempSync(path.join(tmpdir(), "nir1-capacity-probe-"));
  const results = [];
  try {
    for (const spec of fixtureSpecs) {
      const sourceDb = fixturePath(spec, fixtureDirectory);
      const sourceState = captureDatabaseState(sourceDb);
      const warmup = await runChild({
        binary: options.binary,
        projectId: options.projectId,
        spec,
        sourceDb,
        sourceState,
        scratch,
        index: 0,
        warmup: true,
        timeoutMs,
        terminationGraceMs,
        validateObservation,
      });
      const reports = [];
      for (let index = 1; index <= measuredRuns; index += 1) {
        reports.push(
          await runChild({
            binary: options.binary,
            projectId: options.projectId,
            spec,
            sourceDb,
            sourceState,
            scratch,
            index,
            warmup: false,
            timeoutMs,
            terminationGraceMs,
            validateObservation,
          }),
        );
      }
      assertSourceStable(sourceDb, sourceState, `${spec.id} completed runs`);
      results.push({
        fixture: spec,
        sourceDatabaseDigest: sourceState.digest,
        sourceState,
        sourceStateStable: true,
        warmup,
        runs: reports,
        summary: summarize(reports),
        diagnosticOnly: true,
        supportedCapacityClaim: false,
        notMeasured: uniqueNotMeasured([warmup, ...reports]),
      });
    }
    const protocol = {
      ...manifest.runProtocol,
      measuredRunCount: measuredRuns,
      childTimeoutMs: timeoutMs,
      childTerminationGraceMs: terminationGraceMs,
    };
    const notMeasured = uniqueNotMeasured(
      results.flatMap((result) => [result.warmup, ...result.runs]),
    );
    const report = {
      diagnosticOnly: true,
      schemaVersion: "nir1-capacity-report/1",
      manifestDigest,
      protocol,
      capacityDecision: "unratified",
      supportedCapacityClaim: false,
      graphQueryActivation: "not-activated",
      productDispatch: "not-activated",
      activation: { graphQuery: false, productDispatch: false },
      graphLifecycle: {
        status: "not-activated",
        activated: false,
        queryActivation: "not-activated",
        productDispatch: "not-activated",
        supportedCapacityClaim: false,
      },
      notMeasured,
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
}

try {
  await main();
} catch (error) {
  console.error(`[nir1-capacity-probe] ${error.message}`);
  process.exitCode = 1;
}
