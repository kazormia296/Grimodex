// Diagnostic-only NIR-1 B capacity orchestrator.
//
// Fixture databases are prepared elsewhere. This driver keeps the preseeded
// main/WAL/SHM source immutable, gives every warmup and measured sample a
// fresh copy and a fresh child process, and records child state transitions.
// A result is an observation, not a capacity approval or a Graph/product
// activation receipt.
import Ajv2020 from "ajv/dist/2020.js";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const USAGE =
  "usage: node scripts/nir1-material-capacity-probe.mjs <binary> <manifest> <fixture-directory> <output-directory> [project-id] [--fixture <id>] [--mode <mode>] [--runs <n>] [--timeout-ms <n>] [--kill-grace-ms <n>]";
const SOURCE_COMPONENTS = [
  ["main", ""],
  ["wal", "-wal"],
  ["shm", "-shm"],
];
const CHILD_OWNER_ENV = "NIR1_CAPACITY_OWNER_TOKEN";

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
  const requiredPositionals = [
    ["binary", argv[0]],
    ["manifest path", argv[1]],
    ["fixture directory", argv[2]],
    ["output directory", argv[3]],
  ];
  for (const [label, value] of requiredPositionals) {
    if (!value || value.startsWith("--")) {
      fail(`${label} must be a positional argument; ${USAGE}`);
    }
  }
  const [binary, manifestPath, fixtureDirectory, outputDirectory] = argv;
  const options = {
    binary,
    manifestPath,
    fixtureDirectory,
    outputDirectory,
    projectId: null,
    fixtureFilter: null,
    modeFilter: null,
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
    if (value === "--mode" || value === "--diagnostic-mode") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--"))
        fail(`${value} requires a diagnostic mode`);
      if (options.modeFilter !== null) fail("diagnostic mode was provided more than once");
      options.modeFilter = argv[++index];
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
  const requiredModes = [
    "source-reresolution",
    "complete-registration",
    "coverage",
    "restore",
    "cold-reopen",
  ];
  const configuredModes = manifest.diagnosticModes;
  if (
    !Array.isArray(configuredModes) ||
    configuredModes.length !== requiredModes.length ||
    JSON.stringify(configuredModes.map((mode) => mode.id)) !== JSON.stringify(requiredModes)
  ) {
    fail(
      `manifest ${manifestPath} must configure the five independent diagnostic modes: ${requiredModes.join(", ")}`,
    );
  }
  for (const mode of configuredModes) {
    if (typeof mode.producesReportRecords !== "boolean") {
      fail(
        `manifest ${manifestPath} mode ${mode.id} must declare producesReportRecords`,
      );
    }
    const minimumReports = mode.minimumOperationReportRecords;
    if (!minimumReports || typeof minimumReports !== "object") {
      fail(
        `manifest ${manifestPath} mode ${mode.id} must declare minimumOperationReportRecords`,
      );
    }
    for (const fixtureId of mode.fixtures) {
      if (
        !Number.isSafeInteger(minimumReports[fixtureId]) ||
        minimumReports[fixtureId] < 0
      ) {
        fail(
          `manifest ${manifestPath} mode ${mode.id} must declare a non-negative minimum report count for ${fixtureId}`,
        );
      }
    }
    const postOperationShape = mode.postOperationShape;
    if (postOperationShape !== undefined) {
      if (
        postOperationShape === null ||
        typeof postOperationShape !== "object" ||
        Array.isArray(postOperationShape)
      ) {
        fail(
          `manifest ${manifestPath} mode ${mode.id} postOperationShape must be an object`,
        );
      }
      for (const fixtureId of Object.keys(postOperationShape)) {
        if (!mode.fixtures.includes(fixtureId)) {
          fail(
            `manifest ${manifestPath} mode ${mode.id} postOperationShape names unconfigured fixture ${fixtureId}`,
          );
        }
      }
    }
    if (!mode.fixtures.includes("Q8176/R16") || !mode.fixtures.includes("D2064/report-heavy")) {
      fail(
        `manifest ${manifestPath} mode ${mode.id} must cover Q8176/R16 and D2064/report-heavy`,
      );
    }
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
  graphSnapshotDependencyEdges: [
    ["counts", "graphSnapshotDependencyEdges"],
    ["counts", "graphSnapshotEdgeCount"],
    ["graphSnapshotDependencyEdges"],
    ["graphSnapshotEdgeCount"],
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

function validateObservedShape(
  report,
  spec,
  context,
  modeSpec = null,
  {
    ignoreKeys = [],
    expectedShapeOverride = null,
    requiredNullKeys = [],
  } = {},
) {
  const shape = expectedShapeOverride ?? expectedShape(spec);
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
    graphSnapshotDependencyEdges: "Graph snapshot dependency edges",
    reportRecords: "report records",
  };
  const aliases = {
    qualifiedMaterialRecords: "qualifiedMaterials",
    rejectedRevisions: "ineligibleCandidates",
  };
  const checked = new Set();
  for (const [key, expected] of Object.entries(shape)) {
    if (expected === undefined) continue;
    if (key === "reportRecords" && modeSpec?.producesReportRecords === false) {
      continue;
    }
    const canonicalKey = aliases[key] ?? key;
    if (ignoreKeys.includes(canonicalKey)) continue;
    if (checked.has(canonicalKey)) continue;
    checked.add(canonicalKey);
    const observed = firstValue(report, OBSERVED_SHAPE_PATHS[canonicalKey] ?? []);
    if (expected === null && requiredNullKeys.includes(canonicalKey)) {
      if (observed !== null) {
        const observedLabel = observed === undefined ? "missing" : String(observed);
        fail(
          `${context} shape mismatch for ${labels[key] ?? key}: expected null, observed ${observedLabel}`,
        );
      }
      continue;
    }
    if (expected === null) continue;
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

function postOperationShape(spec, modeSpec) {
  return {
    ...expectedShape(spec),
    ...(modeSpec?.postOperationShape?.[spec.id] ?? {}),
  };
}

function postOperationRequiredNullKeys(modeSpec, fixtureId) {
  return Object.entries(modeSpec?.postOperationShape?.[fixtureId] ?? {})
    .filter(([, value]) => value === null)
    .map(([key]) => key);
}

function modeMetricLabel(mode, metric) {
  return `${mode}:${metric}`;
}

function normalizeDiagnosticReport(report, mode) {
  const normalized = structuredClone(report);
  normalized.notMeasured = Array.isArray(normalized.notMeasured)
    ? [...normalized.notMeasured]
    : [];
  const processMetrics = normalized.process ?? (normalized.process = {});
  // Older diagnostic children reported hwmRssBytes only.  Preserve that
  // evidence as the complete child-process peak while still making the new
  // field explicit in every path report.
  processMetrics.totalPeakRssBytes ??= processMetrics.hwmRssBytes ?? null;
  processMetrics.temporaryBytes ??= null;
  const missingMetrics = [
    ["total-peak-rss", processMetrics.totalPeakRssBytes],
    ["temporary-bytes", processMetrics.temporaryBytes],
    ["foreground-wait", normalized.occupancy?.foregroundWaitMs],
    ["cancel-latency", normalized.cancel?.latencyMs],
    ["publish-hold", normalized.graphLifecycle?.publishOwnerMs],
  ];
  for (const [metric, value] of missingMetrics) {
    if (value === null || value === undefined) {
      const label = modeMetricLabel(mode, metric);
      if (!normalized.notMeasured.includes(label)) normalized.notMeasured.push(label);
    }
  }
  normalized.notMeasured = [...new Set(normalized.notMeasured)];
  return normalized;
}

function assertRawDiagnosticIdentity(report, spec, mode, context) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail(`${context} did not emit a JSON object`);
  }
  if (report.fixtureId !== spec.id) {
    fail(`${context} reported fixtureId ${String(report.fixtureId)}, expected ${spec.id}`);
  }
  if (report.mode !== mode) {
    fail(`${context} reported mode ${String(report.mode)}, expected ${mode}`);
  }
  if (report.supportedCapacityClaim !== false) {
    fail(`${context} must explicitly report supportedCapacityClaim=false`);
  }
}

function assertDiagnosticReport(
  report,
  spec,
  mode,
  context,
  validateObservation,
  modeSpec,
) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail(`${context} did not emit a JSON object`);
  }
  if (report.diagnosticOnly !== true) {
    fail(`${context} must report diagnosticOnly=true`);
  }
  if (report.fixtureId !== spec.id) {
    fail(`${context} reported fixtureId ${String(report.fixtureId)}, expected ${spec.id}`);
  }
  if (report.mode !== mode) {
    fail(`${context} reported mode ${String(report.mode)}, expected ${mode}`);
  }
  if (report.supportedCapacityClaim !== false) {
    fail(`${context} must explicitly report supportedCapacityClaim=false`);
  }
  if (report.status !== "measured") {
    fail(`${context} must report status=measured; got ${String(report.status)}`);
  }
  if (!report.fixtureShape || typeof report.fixtureShape !== "object") {
    fail(`${context} must include an immutable fixtureShape`);
  }
  if (!report.modeOutcome || typeof report.modeOutcome !== "object") {
    fail(`${context} must include modeOutcome`);
  }
  if (report.modeOutcome.success !== true || report.modeOutcome.requiredSuccess !== true) {
    fail(`${context} modeOutcome must have success=true and requiredSuccess=true`);
  }
  if (typeof report.modeOutcome.operation !== "string" || report.modeOutcome.operation.length === 0) {
    fail(`${context} modeOutcome.operation must be a non-empty string`);
  }
  if (modeSpec?.producesReportRecords === true) {
    const minimumReports = modeSpec.minimumOperationReportRecords?.[spec.id];
    if (
      !Number.isSafeInteger(report.modeOutcome.operationReportRecords) ||
      report.modeOutcome.operationReportRecords < minimumReports
    ) {
      fail(
        `${context} undercounted operation-produced report records for ${mode}: expected at least ${minimumReports}, observed ${String(report.modeOutcome.operationReportRecords)}`,
      );
    }
  } else if (report.modeOutcome.operationReportRecords !== null) {
    fail(`${context} must report operationReportRecords=null for ${mode}`);
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
  validateObservedShape(
    report,
    spec,
    `${context} post-operation Graph shape`,
    modeSpec,
    {
      expectedShapeOverride: postOperationShape(spec, modeSpec),
      requiredNullKeys: postOperationRequiredNullKeys(modeSpec, spec.id),
    },
  );
  validateObservedShape(
    { counts: report.fixtureShape },
    spec,
    `${context} fixtureShape`,
    null,
    { ignoreKeys: ["graphSnapshotDependencyEdges"] },
  );
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

function scanOwnedProcessIds(ownerToken, knownPids = [], pipeInodes = []) {
  if (process.platform !== "linux") {
    return {
      supported: false,
      pids: [],
      error: new Error(`unsupported platform ${process.platform}; Linux /proc ownership is required`),
    };
  }
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    return { supported: false, pids: [], error };
  }
  const known = new Set(knownPids);
  const token = `${CHILD_OWNER_ENV}=${ownerToken}`;
  const ownedPipes = new Set(pipeInodes);
  const pids = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let ownsPipe = false;
    try {
      const environment = readFileSync(path.join("/proc", entry, "environ"), "utf8");
      if (environment.split("\0").includes(token)) pids.push(pid);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (known.has(pid)) {
        return { supported: false, pids, error };
      }
    }
    if (ownedPipes.size > 0) {
      try {
        for (const fd of readdirSync(path.join("/proc", entry, "fd"))) {
          try {
            if (ownedPipes.has(readlinkSync(path.join("/proc", entry, "fd", fd)))) {
              ownsPipe = true;
              break;
            }
          } catch (error) {
            if (error.code !== "ENOENT" && known.has(pid)) {
              return { supported: false, pids, error };
            }
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT" && known.has(pid)) {
          return { supported: false, pids, error };
        }
      }
    }
    if (ownsPipe && !pids.includes(pid)) pids.push(pid);
  }
  return { supported: true, pids, error: null };
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
    let finalizing = false;
    let timeoutTimer = null;
    let termTimer = null;
    let killTimer = null;
    let streamTimer = null;
    const ownerToken = `${process.pid}-${randomUUID()}`;
    const knownOwnedPids = new Set();
    let ownedPipeInodes = [];
    let pipeOwnershipError = null;

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
      for (const stream of [child?.stdout, child?.stderr]) {
        if (stream && !stream.destroyed) stream.destroy();
      }
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

    const destroyStreams = () => {
      for (const stream of [child?.stdout, child?.stderr]) {
        if (stream && !stream.destroyed) stream.destroy();
      }
    };

    const sendSignal = (signal) => {
      const pid = child?.pid;
      if (process.platform !== "win32" && Number.isInteger(pid) && pid > 0) {
        try {
          // A detached child owns its process group. Signalling the group
          // also reaps descendants which may have inherited our output pipes.
          process.kill(-pid, signal);
          return true;
        } catch (error) {
          if (error.code !== "ESRCH") {
            stderr += `\nfailed to send ${signal} to process group: ${error.message}`;
          }
        }
      }
      try {
        return child?.kill(signal) === true;
      } catch (error) {
        stderr += `\nfailed to send ${signal}: ${error.message}`;
        return false;
      }
    };

    const scanOwned = (includePipes = true) => {
      if (includePipes && pipeOwnershipError) {
        const tokenOnly = scanOwnedProcessIds(ownerToken, [
          child?.pid,
          ...knownOwnedPids,
        ]);
        if (tokenOnly.supported) {
          for (const pid of tokenOnly.pids) knownOwnedPids.add(pid);
        }
        return { ...tokenOnly, supported: false, error: pipeOwnershipError };
      }
      const result = scanOwnedProcessIds(ownerToken, [
        child?.pid,
        ...knownOwnedPids,
      ], includePipes ? ownedPipeInodes : []);
      if (result.supported) {
        for (const pid of result.pids) knownOwnedPids.add(pid);
      }
      return result;
    };

    const captureOwnedPipes = () => {
      const inodes = [];
      for (const [stream, childFd] of [
        [child?.stdout, 1],
        [child?.stderr, 2],
      ]) {
        const fd = stream?._handle?.fd;
        if (!Number.isInteger(fd) || fd < 0) {
          pipeOwnershipError = new Error(
            `${context} could not identify its owned output pipe`,
          );
          return;
        }
        try {
          // The descendant inherits the child's endpoint of the socketpair,
          // whose inode differs from the runner's endpoint.
          const target = readlinkSync(`/proc/${child.pid}/fd/${childFd}`);
          if (!/^(?:pipe|socket):\[\d+\]$/.test(target)) {
            pipeOwnershipError = new Error(
              `${context} output handle ${fd} is not a Linux pipe`,
            );
            return;
          }
          inodes.push(target);
        } catch (error) {
          pipeOwnershipError = error;
          return;
        }
      }
      ownedPipeInodes = inodes;
    };

    const signalOwned = (pids, signal) => {
      let sent = false;
      for (const pid of pids) {
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
        try {
          process.kill(pid, signal);
          sent = true;
        } catch (error) {
          if (error.code !== "ESRCH") {
            stderr += `\nfailed to send ${signal} to owned process ${pid}: ${error.message}`;
          }
        }
      }
      return sent;
    };

    const waitForOwnedProcesses = (waitMs) =>
      new Promise((waitResolve) => {
        const deadline = Date.now() + waitMs;
        const poll = () => {
          const ownership = scanOwned(true);
          if (!ownership.supported || ownership.pids.length === 0) {
            waitResolve({
              confirmed: ownership.supported,
              ownership,
            });
            return;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            waitResolve({ confirmed: false, ownership });
            return;
          }
          setTimeout(poll, Math.min(10, remaining));
        };
        poll();
      });

    const finalizeLifecycleFailure = (lifecycleError) => {
      if (settled || finalizing) return;
      finalizing = true;
      killSent = sendSignal("SIGKILL") || killSent;
      const ownership = scanOwned();
      if (ownership.supported) {
        killSent = signalOwned(ownership.pids, "SIGKILL") || killSent;
      }
      destroyStreams();
      void waitForOwnedProcesses(terminationGraceMs).then(({ confirmed, ownership: finalOwnership }) => {
        const detail = confirmed
          ? ""
          : finalOwnership?.error
            ? `; unable to verify owned process termination: ${finalOwnership.error.message}`
            : `; owned process termination was not confirmed (${(finalOwnership?.pids ?? []).join(", ")})`;
        finish({
          lifecycleError: new Error(`${lifecycleError.message}${detail}`),
        });
      });
    };

    const finishAfterExit = () => {
      if (settled || finalizing || exitInfo === null) return;
      if (streamsClosed) {
        const ownership = scanOwned(false);
        if (!ownership.supported) {
          finalizeLifecycleFailure(
            new Error(
              `${context} exited but owned process termination could not be verified`,
            ),
          );
        } else if (ownership.pids.length > 0) {
          finalizeLifecycleFailure(
            new Error(
              `${context} exited while owned processes remained (${ownership.pids.join(", ")})`,
            ),
          );
        } else {
          finish();
        }
        return;
      }
      if (streamTimer === null) {
        streamTimer = setTimeout(() => {
          finalizeLifecycleFailure(
            new Error(
              `${context} exited but its output streams did not close within ${terminationGraceMs}ms`,
            ),
          );
        }, terminationGraceMs);
      }
    };

    try {
      child = spawn(path.resolve(binary), childArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: { ...process.env, [CHILD_OWNER_ENV]: ownerToken },
        windowsHide: true,
      });
      if (Number.isInteger(child.pid) && child.pid > 0) {
        knownOwnedPids.add(child.pid);
      }
      captureOwnedPipes();
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
        if (child?.pid) {
          finalizeLifecycleFailure(error);
        } else {
          finish({ error });
        }
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
          finalizeLifecycleFailure(
            new Error(
              `${context} did not exit after SIGKILL within ${terminationGraceMs}ms`,
            ),
          );
        }, terminationGraceMs);
      }, terminationGraceMs);
    }, timeoutMs);
  });
}

function childFailureMessage(child, context, binary, timeoutMs) {
  if (child.lifecycleError) {
    return `${context} lifecycle failure: ${child.lifecycleError.message}`;
  }
  if (child.error?.code === "ETIMEDOUT" || child.timedOut) {
    return `${context} timed out after ${timeoutMs}ms (binary ${binary})`;
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
  mode,
  modeSpec,
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
  const context = `${spec.id} ${runLabel} [${mode}]`;
  const childPath = path.join(
    scratch,
    safeChildName(spec.id, `${mode}-${warmup ? "warmup" : `run-${index}`}`),
  );
  copyPreseedState(sourceDb, childPath);
  const before = captureDatabaseState(childPath);
  const childArgs = [childPath, spec.id];
  if (projectId !== null) childArgs.push(projectId);
  childArgs.push("--mode", mode);
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
    child.lifecycleError ||
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
  // Identity and diagnostic-only claim are admission data from the child.
  // Validate them before any compatibility normalization so a malformed child
  // cannot be repaired into an apparently valid observation.
  assertRawDiagnosticIdentity(rawReport, spec, mode, context);
  const report = normalizeDiagnosticReport(rawReport, mode);
  assertDiagnosticReport(
    report,
    spec,
    mode,
    context,
    validateObservation,
    modeSpec,
  );
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
      report.process?.totalPeakRssBytes ??
      report.process?.hwmRssBytes ??
      report.process?.ruMaxrssBytes ??
      null,
  );
  const medianMetric = (selector) => median(numericValues(reports, selector));
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
    medianUserCpuUs: medianMetric((report) => report.process?.userCpuUs),
    medianSystemCpuUs: medianMetric((report) => report.process?.systemCpuUs),
    medianReadBytes: medianMetric((report) => report.process?.readBytes),
    medianWriteBytes: medianMetric((report) => report.process?.writeBytes),
    medianTemporaryBytes: medianMetric((report) => report.process?.temporaryBytes),
    medianConnectionHoldMs: medianMetric(
      (report) => report.occupancy?.connectionHoldMs,
    ),
    medianPublishHoldMs: medianMetric(
      (report) => report.graphLifecycle?.publishOwnerMs,
    ),
    medianPublishTransactionMs: medianMetric(
      (report) => report.occupancy?.publishTransactionMs,
    ),
    medianForegroundWaitMs: medianMetric(
      (report) => report.occupancy?.foregroundWaitMs,
    ),
    medianCancelLatencyMs: medianMetric(
      (report) => report.cancel?.latencyMs,
    ),
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

function removePreviousReport(outputDirectory) {
  const reportPath = path.join(path.resolve(outputDirectory), "capacity-report.json");
  rmSync(reportPath, { force: true });
}

function modesForFixture(manifest, spec, requestedMode) {
  const configuredModes = manifest.diagnosticModes.map((mode) => mode.id);
  const knownModes = ["full-build", ...configuredModes];
  if (requestedMode !== null) {
    if (!knownModes.includes(requestedMode)) {
      fail(`unknown diagnostic mode: ${requestedMode}`);
    }
    if (
      requestedMode !== "full-build" &&
      !manifest.diagnosticModes.some(
        (mode) => mode.id === requestedMode && mode.fixtures.includes(spec.id),
      )
    ) {
      fail(`diagnostic mode ${requestedMode} is not configured for fixture ${spec.id}`);
    }
    return [requestedMode];
  }
  return [
    "full-build",
    ...manifest.diagnosticModes
      .filter((mode) => mode.fixtures.includes(spec.id))
      .map((mode) => mode.id),
  ];
}

async function runDiagnosticMode({
  binary,
  projectId,
  spec,
  mode,
  modeSpec,
  sourceDb,
  sourceState,
  scratch,
  measuredRuns,
  timeoutMs,
  terminationGraceMs,
  validateObservation,
}) {
  const warmup = await runChild({
    binary,
    projectId,
    spec,
    mode,
    modeSpec,
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
        binary,
        projectId,
        spec,
        mode,
        modeSpec,
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
  assertSourceStable(sourceDb, sourceState, `${spec.id} ${mode} completed runs`);
  return {
    fixture: spec,
    fixtureShape: expectedShape(spec),
    mode,
    sourceDatabaseDigest: sourceState.digest,
    sourceState,
    sourceStateStable: true,
    warmup,
    runs: reports,
    summary: summarize(reports),
    diagnosticOnly: true,
    supportedCapacityClaim: false,
    notMeasured: uniqueNotMeasured([warmup, ...reports]),
  };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const options = parseCli(rawArgs);
  // Parse all required positionals before touching the filesystem. An option
  // token in any required slot must not let an invalid invocation delete a
  // report through a later positional value.
  removePreviousReport(options.outputDirectory);
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
  const reportPath = path.join(outputDirectory, "capacity-report.json");
  // A failed rerun must not leave a prior successful artifact looking current.
  removePreviousReport(outputDirectory);
  if (process.platform !== "linux") {
    fail(`unsupported platform ${process.platform}; Linux /proc ownership is required`);
  }
  const manifestDigest = hashBytes(Buffer.from(JSON.stringify(manifest)));
  const scratch = mkdtempSync(path.join(tmpdir(), "nir1-capacity-probe-"));
  const results = [];
  try {
    for (const spec of fixtureSpecs) {
      const sourceDb = fixturePath(spec, fixtureDirectory);
      const sourceState = captureDatabaseState(sourceDb);
      const modeResults = [];
      for (const mode of modesForFixture(manifest, spec, options.modeFilter)) {
        const modeSpec =
          mode === "full-build"
            ? {
                id: mode,
                producesReportRecords: true,
                minimumOperationReportRecords: {
                  [spec.id]: expectedShape(spec).reportRecords ?? 0,
                },
              }
            : manifest.diagnosticModes.find((candidate) => candidate.id === mode);
        if (!modeSpec) fail(`manifest mode ${mode} is missing its configuration`);
        modeResults.push(
          await runDiagnosticMode({
            binary: options.binary,
            projectId: options.projectId,
            spec,
            mode,
            modeSpec,
            sourceDb,
            sourceState,
            scratch,
            measuredRuns,
            timeoutMs,
            terminationGraceMs,
            validateObservation,
          }),
        );
      }
      const primary =
        modeResults.find((result) => result.mode === "full-build") ?? modeResults[0];
      results.push({
        ...primary,
        // `modeResults` is the canonical per-path record.  The legacy top
        // level warmup/runs fields remain the full-build path for consumers
        // that already understand the original diagnostic artifact.
        modeResults,
        paths: modeResults,
      });
    }
    const protocol = {
      ...manifest.runProtocol,
      measuredRunCount: measuredRuns,
      childTimeoutMs: timeoutMs,
      childTerminationGraceMs: terminationGraceMs,
      modeFilter: options.modeFilter,
    };
    const notMeasured = uniqueNotMeasured(
      results.flatMap((result) =>
        result.modeResults.flatMap((modeResult) => [
          modeResult.warmup,
          ...modeResult.runs,
        ]),
      ),
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
      diagnosticModes: results.flatMap((result) =>
        result.modeResults.map((modeResult) => modeResult.mode),
      ),
      paths: results.flatMap((result) => result.modeResults),
      notMeasured,
      results,
    };
    const stagedReportPath = path.join(
      outputDirectory,
      `.capacity-report-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(stagedReportPath, JSON.stringify(report, null, 2) + "\n");
      renameSync(stagedReportPath, reportPath);
    } finally {
      rmSync(stagedReportPath, { force: true });
    }
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
