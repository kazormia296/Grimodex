#!/usr/bin/env node
/**
 * Maintainer-local live provider/model qualification.
 *
 * This is intentionally not a Gate B2 runner. It refuses GitHub Actions,
 * records no credentials, and uses QUALIFIED/HOLD/FAILED/INCOMPLETE so its
 * evidence cannot be mistaken for an Engineering Certification decision.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import yaml from "js-yaml";
import {
  AI_PROVIDER_CREDENTIAL_ENV_NAMES,
  NARRATIVE_EVAL_SELECTOR_ENV_NAMES,
  resolveHeavyCommand,
  runShellStringCommand,
  sanitizeCapturedBuffer,
  sanitizeCapturedText,
  sanitizeEvaluationEnv,
  sanitizeStructuredArtifact,
  sha256Buffer,
  sha256Text,
  stripCommandEnvironmentAssignments,
  stripCredentialPlaceholders,
  CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS,
  CURRENT_NARRATIVE_EVAL_PROTOCOL,
  validateChronicleProductionCaseAccounting,
  validateChronicleProductionCertificationAccounting,
  validateCurrentNarrativeEvalProtocolBinding,
  validateHeavyReportBinding,
} from "./quality-evaluation-runtime.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DEFAULT_MANIFEST_RELATIVE = "evals/qualifications/live-models.yaml";
const COMMIT_RE = /^[0-9a-f]{40}$/;
const RESULT_POLICIES = new Set(["exit-code", "chronicle-semantic"]);
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_DIAGNOSTICS_MAX_BYTES = 1024 * 1024;
const SOURCE_DIAGNOSTICS_MAX_DEPTH = 32;
const SOURCE_DIAGNOSTICS_MAX_COLLECTION_LENGTH = 1024;
const SOURCE_DIAGNOSTICS_MAX_OBJECT_KEYS = 128;
const SOURCE_DIAGNOSTICS_MAX_NODES = 50_000;
const SOURCE_DIAGNOSTICS_MAX_INVOCATIONS_PER_CASE = 128;
const SOURCE_DIAGNOSTICS_MAX_ERRORS_PER_INVOCATION = 128;
const SOURCE_DIAGNOSTICS_MAX_COUNT = 10_000;
const FAILURE_DIAGNOSTICS_FILE = "failure-diagnostics.json";
const valueSet = (...values) => new Set(values);
const CHRONICLE_STAGE_IDS = valueSet(
  "narrative_observation_extract",
  "narrative_event_synthesize",
);
const CHRONICLE_FINISH_REASONS = valueSet(
  "completed",
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "cancelled",
);
const CHRONICLE_STOP_REASONS = valueSet("end_turn", "tool_use", "max_tokens");
const CHRONICLE_PARSE_STATUSES = valueSet("parsed", "invalid");
const CHRONICLE_JSON_STATUSES = valueSet(
  "empty",
  "object-not-found",
  "root-not-object",
  "unbalanced-object",
  "syntax-error",
  "object-found",
);
const CHRONICLE_JSON_ROOT_TYPES = valueSet(
  "empty",
  "unknown",
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
);
const CHRONICLE_VALIDATION_STATUSES = valueSet(
  "valid",
  "invalid",
  "not-evaluated",
);
const CHRONICLE_SCHEMA_ERROR_CODES = valueSet(
  "SCHEMA_INVALID",
  "SCHEMA_REQUIRED",
  "SCHEMA_TYPE",
  "SCHEMA_NO_VALID_REFS",
  "SCHEMA_UNKNOWN",
);
const CHRONICLE_REF_ERROR_CODES = valueSet(
  "UNKNOWN_SOURCE_REF",
  "UNKNOWN_EVIDENCE_REF",
  "UNKNOWN_OBSERVATION_REF",
  "CLUSTER_REF_MISMATCH",
);
const CHRONICLE_CITATION_STATUSES = valueSet(
  "resolved",
  "rejected",
  "not-evaluated",
);
const CHRONICLE_SAFE_DIAGNOSTIC_PATHS = [
  /^(?:assertion\.(?:attribution|narrativeFrame)|payload\.(?:predicate|actuality|durationKind|participants|temporalExpressions))$/,
  /^(?:observations|events|clusterRef|resolution)$/,
  /^observations\[\d+\]\.(?:localId|evidence|evidenceRefs|assertion|payload|root)$/,
  /^observations\[\d+\]\.(?:evidence|evidenceRefs|payload\.participants)\[\d+\](?:\.(?:sourceRef|quote|surface|role))?$/,
  /^observations\[\d+\]\.(?:assertion\.(?:attribution|narrativeFrame)|payload\.(?:predicate|actuality|durationKind|participants|temporalExpressions))$/,
  /^events\[\d+\](?:\.observationRefs(?:\[\d+\])?|\.titleSuggestion|\.summary|\.actuality|\.significance)?$/,
];
const FAILURE_DIAGNOSTICS_UNAVAILABLE_REASONS = valueSet(
  "source-missing",
  "source-read-failed",
  "source-malformed",
  "source-oversize",
  "source-depth-limit",
  "source-cardinality-limit",
  "source-binding-mismatch",
  "source-report-invalid",
  "source-invalid",
  "source-parity-mismatch",
  "projection-persist-failed",
);
const CREDENTIAL_ENV_NAME_PATTERN =
  /(?:^|_)(?:API_?KEY|ACCESS_KEY(?:_ID)?|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTHORIZATION)(?:$|_)/i;
const CHILD_ENV_REMOVALS = [
  "GITHUB_ACTIONS",
  "GATE_B2_ATTEMPT",
  "GATE_B2_CANDIDATE_COMMIT_SHA",
  "GATE_B2_CANDIDATE_TREE_SHA",
  "GATE_B2_CERTIFICATION_RUN_ID",
  "GATE_B2_COMMAND_DIGEST",
  "GATE_B2_FREEZE_ID",
  "GATE_B2_OUTPUT_PATH",
  "GATE_B2_RUN_ID",
  "GATE_B2_SUITE_ID",
  "NARRATIVE_EVAL_ATTEMPT",
  "NARRATIVE_EVAL_CASE_ID",
  "NARRATIVE_EVAL_LIMIT",
  ...NARRATIVE_EVAL_SELECTOR_ENV_NAMES,
];

export function parseLiveModelQualificationArgs(argv) {
  const result = {
    candidate: "HEAD",
    provider: null,
    model: null,
    reasoningEffort: null,
    suites: [],
    allowDirty: false,
    artifactRoot: null,
    manifest: DEFAULT_MANIFEST_RELATIVE,
    format: "markdown",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--candidate") result.candidate = takeValue();
    else if (arg === "--provider") result.provider = takeValue();
    else if (arg === "--model") result.model = takeValue();
    else if (arg === "--reasoning-effort") {
      result.reasoningEffort = takeValue();
    } else if (arg === "--suite") result.suites.push(takeValue());
    else if (arg === "--allow-dirty") result.allowDirty = true;
    else if (arg === "--artifact-root") result.artifactRoot = takeValue();
    else if (arg === "--manifest") result.manifest = takeValue();
    else if (arg === "--format") {
      const format = takeValue();
      if (!new Set(["markdown", "json"]).has(format)) {
        throw new Error(`Unsupported format: ${format}`);
      }
      result.format = format;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (new Set(result.suites).size !== result.suites.length) {
    throw new Error("--suite values must be unique");
  }
  return result;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function credentialEnvironmentNames(env) {
  return Object.keys(env).filter((name) =>
    CREDENTIAL_ENV_NAME_PATTERN.test(name),
  );
}

export function validateLiveModelQualificationManifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return ["manifest must be an object"];
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (raw.id !== "grimodex-live-model-qualification") {
    errors.push("id must be grimodex-live-model-qualification");
  }
  const policy = raw.executionPolicy ?? {};
  if (
    policy.location !== "maintainer-local" ||
    policy.allowGitHubActions !== false ||
    policy.requiredForGateB2 !== false ||
    policy.requiredForMerge !== false
  ) {
    errors.push(
      "executionPolicy must be maintainer-local, forbid GitHub Actions, and remain optional for Gate B2/merge",
    );
  }
  if (!nonEmpty(raw.provider)) errors.push("provider is required");
  if (
    !Array.isArray(raw.allowedReasoningEfforts) ||
    raw.allowedReasoningEfforts.length === 0
  ) {
    errors.push("allowedReasoningEfforts must be a non-empty array");
  }
  if (!Array.isArray(raw.defaultProfile) || raw.defaultProfile.length === 0) {
    errors.push("defaultProfile must be a non-empty array");
  }
  if (
    new Set(raw.defaultProfile ?? []).size !== (raw.defaultProfile ?? []).length
  ) {
    errors.push("defaultProfile must not contain duplicates");
  }
  const suiteIds = new Set();
  for (const suite of raw.qualificationSuites ?? []) {
    if (!nonEmpty(suite?.id)) {
      errors.push("qualificationSuites entry missing id");
      continue;
    }
    if (suiteIds.has(suite.id)) {
      errors.push(`duplicate qualification suite: ${suite.id}`);
    }
    suiteIds.add(suite.id);
    if (!RESULT_POLICIES.has(suite.resultPolicy)) {
      errors.push(`unsupported resultPolicy for ${suite.id}`);
    }
  }
  for (const suiteId of raw.defaultProfile ?? []) {
    if (!suiteIds.has(suiteId)) {
      errors.push(
        `defaultProfile references unknown qualification suite: ${suiteId}`,
      );
    }
  }
  if (
    !Array.isArray(raw.requiredEnvironment) ||
    !raw.requiredEnvironment.includes("OPENROUTER_API_KEY")
  ) {
    errors.push("requiredEnvironment must include OPENROUTER_API_KEY");
  }
  for (const field of ["qualityManifest", "reportSchema", "artifactRoot"]) {
    if (!nonEmpty(raw[field])) errors.push(`${field} is required`);
  }
  return errors;
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed: ${err || out}`));
        return;
      }
      resolve(out);
    });
  });
}

export async function resolveQualificationCandidate(
  repoRoot,
  candidate = "HEAD",
) {
  const commitSha = (
    await runGit(["rev-parse", candidate], repoRoot)
  ).toLowerCase();
  const treeSha = (
    await runGit(["rev-parse", `${commitSha}^{tree}`], repoRoot)
  ).toLowerCase();
  if (!COMMIT_RE.test(commitSha) || !COMMIT_RE.test(treeSha)) {
    throw new Error("candidate commit/tree identity is invalid");
  }
  const dirty = Boolean(await runGit(["status", "--porcelain"], repoRoot));
  return { commitSha, treeSha, dirty };
}

function resolveRepoPath(repoRoot, candidate) {
  return path.isAbsolute(candidate)
    ? candidate
    : path.join(repoRoot, candidate);
}

async function loadQualificationModel(repoRoot, manifestPath) {
  const resolvedManifestPath = resolveRepoPath(repoRoot, manifestPath);
  const manifestText = await readFile(resolvedManifestPath, "utf8");
  const manifest = yaml.load(manifestText);
  const errors = validateLiveModelQualificationManifest(manifest);
  if (errors.length > 0) {
    throw new Error(
      `Invalid live qualification manifest:\n- ${errors.join("\n- ")}`,
    );
  }
  const qualityText = await readFile(
    resolveRepoPath(repoRoot, manifest.qualityManifest),
    "utf8",
  );
  const qualityManifest = yaml.load(qualityText);
  const qualityIndex = {
    heavy: new Map(
      (qualityManifest?.heavyEvaluations ?? []).map((entry) => [
        entry.id,
        entry,
      ]),
    ),
    blocked: new Map(
      (qualityManifest?.blockedEvaluations ?? []).map((entry) => [
        entry.id,
        entry,
      ]),
    ),
  };
  const schema = JSON.parse(
    await readFile(resolveRepoPath(repoRoot, manifest.reportSchema), "utf8"),
  );
  return {
    manifest,
    manifestDigest: sha256Text(manifestText),
    qualityIndex,
    schema,
  };
}

function validateAgainstSchema(document, schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const ok = validate(document);
  return { ok: Boolean(ok), errors: validate.errors ?? [] };
}

function qualificationRunId(startedAt, idFactory) {
  const stamp = startedAt.replace(/[-:.TZ]/g, "");
  return `${stamp}-${idFactory()}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class FailureDiagnosticsSourceError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function rejectFailureDiagnostics(reason = "source-invalid") {
  throw new FailureDiagnosticsSourceError(reason);
}

function boundedCount(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > SOURCE_DIAGNOSTICS_MAX_COUNT
  ) {
    rejectFailureDiagnostics();
  }
  return value;
}

function boundedInvocationIndex(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= SOURCE_DIAGNOSTICS_MAX_INVOCATIONS_PER_CASE
  ) {
    rejectFailureDiagnostics();
  }
  return value;
}

function fixedEnum(value, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    rejectFailureDiagnostics();
  }
  return value;
}

function sourceDiagnosticsBoundsReason(value) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > SOURCE_DIAGNOSTICS_MAX_NODES) {
      return "source-cardinality-limit";
    }
    if (current.depth > SOURCE_DIAGNOSTICS_MAX_DEPTH) {
      return "source-depth-limit";
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > SOURCE_DIAGNOSTICS_MAX_COLLECTION_LENGTH) {
        return "source-cardinality-limit";
      }
      for (const nested of current.value) {
        stack.push({ value: nested, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      const values = Object.values(current.value);
      if (values.length > SOURCE_DIAGNOSTICS_MAX_OBJECT_KEYS) {
        return "source-cardinality-limit";
      }
      for (const nested of values) {
        stack.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

async function readBoundedSourceDiagnostics(target) {
  let handle;
  try {
    handle = await open(target, "r");
  } catch (error) {
    return {
      ok: false,
      reason:
        error?.code === "ENOENT" ? "source-missing" : "source-read-failed",
    };
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      return { ok: false, reason: "source-read-failed" };
    }
    if (metadata.size > SOURCE_DIAGNOSTICS_MAX_BYTES) {
      return { ok: false, reason: "source-oversize" };
    }
    const bytes = Buffer.alloc(SOURCE_DIAGNOSTICS_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > SOURCE_DIAGNOSTICS_MAX_BYTES) {
      return { ok: false, reason: "source-oversize" };
    }
    let value;
    try {
      value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    } catch {
      return { ok: false, reason: "source-malformed" };
    }
    const boundsReason = sourceDiagnosticsBoundsReason(value);
    return boundsReason
      ? { ok: false, reason: boundsReason }
      : { ok: true, value };
  } catch {
    return { ok: false, reason: "source-read-failed" };
  } finally {
    await handle.close().catch(() => {});
  }
}

function isAllowedSchemaPath(pathValue) {
  return (
    pathValue === "<redacted>" ||
    CHRONICLE_SAFE_DIAGNOSTIC_PATHS.some((pattern) => pattern.test(pathValue))
  );
}

function projectDiagnosticErrors(value, allowedCodes) {
  if (
    !Array.isArray(value) ||
    value.length > SOURCE_DIAGNOSTICS_MAX_ERRORS_PER_INVOCATION
  ) {
    rejectFailureDiagnostics();
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      entry.path.length > 256
    ) {
      rejectFailureDiagnostics();
    }
    const code = fixedEnum(entry.code, allowedCodes);
    return {
      code,
      path: isAllowedSchemaPath(entry.path) ? entry.path : "<redacted>",
    };
  });
}

function projectValidationDiagnostic(value, allowedCodes) {
  if (!isRecord(value)) rejectFailureDiagnostics();
  const status = fixedEnum(value.status, CHRONICLE_VALIDATION_STATUSES);
  const errors = projectDiagnosticErrors(value.errors, allowedCodes);
  return { status, errors };
}

function projectRefsDiagnostic(value) {
  const projected = projectValidationDiagnostic(
    value,
    CHRONICLE_REF_ERROR_CODES,
  );
  const checkedCount = boundedCount(value.checkedCount);
  const rejectedCount = boundedCount(value.rejectedCount);
  return {
    ...projected,
    checkedCount,
    rejectedCount,
    errors: projected.errors,
  };
}

function projectCitationDiagnostic(value) {
  if (!isRecord(value)) rejectFailureDiagnostics();
  const status = fixedEnum(value.status, CHRONICLE_CITATION_STATUSES);
  const checkedCount = boundedCount(value.checkedCount);
  const rejectedCount = boundedCount(value.rejectedCount);
  const resolvedCount = boundedCount(value.resolvedCount);
  return { status, checkedCount, rejectedCount, resolvedCount };
}

function projectOutputDiagnostic(value) {
  if (!isRecord(value)) rejectFailureDiagnostics();
  return Object.fromEntries(
    [
      "candidateCount",
      "schemaAcceptedCount",
      "schemaRejectedCount",
      "normalizerDroppedCount",
      "acceptedCount",
      "rejectedCount",
      "salvagedCount",
    ].map((key) => [key, boundedCount(value[key])]),
  );
}

function projectStageDiagnostic(value) {
  if (!isRecord(value)) rejectFailureDiagnostics();
  const stageId = fixedEnum(value.stageId, CHRONICLE_STAGE_IDS);
  const invocationIndex = boundedInvocationIndex(value.invocationIndex);
  if (
    stageId === "narrative_observation_extract" &&
    value.evidenceMode !== CURRENT_NARRATIVE_EVAL_PROTOCOL.evidenceMode
  ) {
    rejectFailureDiagnostics("source-binding-mismatch");
  }
  const json = isRecord(value.json)
    ? {
        status: fixedEnum(value.json.status, CHRONICLE_JSON_STATUSES),
        rootType: fixedEnum(value.json.rootType, CHRONICLE_JSON_ROOT_TYPES),
      }
    : rejectFailureDiagnostics();
  const schema = projectValidationDiagnostic(
    value.schema,
    CHRONICLE_SCHEMA_ERROR_CODES,
  );
  const refs = projectRefsDiagnostic(value.refs);
  const citation =
    stageId === "narrative_observation_extract"
      ? projectCitationDiagnostic(value.citation)
      : null;
  if (
    stageId === "narrative_event_synthesize" &&
    Object.hasOwn(value, "citation")
  ) {
    rejectFailureDiagnostics();
  }
  const output = projectOutputDiagnostic(value.output);
  const expectedParseStatus = fixedEnum(
    value.expectedParseStatus,
    CHRONICLE_PARSE_STATUSES,
  );
  const parseStatus = fixedEnum(value.parseStatus, CHRONICLE_PARSE_STATUSES);
  if (parseStatus !== expectedParseStatus) {
    rejectFailureDiagnostics("source-parity-mismatch");
  }
  const projected = {
    stageId,
    invocationIndex,
    json,
    schema,
    refs,
    ...(citation ? { citation } : {}),
    output,
    expectedParseStatus,
    parseStatus,
  };
  const relevant =
    parseStatus === "invalid" ||
    json.status !== "object-found" ||
    schema.status !== "valid" ||
    refs.status === "invalid" ||
    citation?.status === "rejected" ||
    output.schemaRejectedCount > 0 ||
    output.normalizerDroppedCount > 0 ||
    output.rejectedCount > 0 ||
    output.salvagedCount > 0;
  return {
    key: `${stageId}:${invocationIndex}`,
    projected,
    relevant,
  };
}

function parseInvocationKey(value) {
  if (typeof value !== "string" || value.length > 80) {
    rejectFailureDiagnostics();
  }
  const match =
    /^(narrative_observation_extract|narrative_event_synthesize):(\d+)$/.exec(
      value,
    );
  if (!match) rejectFailureDiagnostics();
  boundedInvocationIndex(Number(match[2]));
  return value;
}

function projectTerminalFailure(value) {
  if (value === undefined) return null;
  if (!isRecord(value)) rejectFailureDiagnostics();
  if (value.kind === "terminal-pipeline-failure") {
    const absent =
      value.stageId === null &&
      value.invocationIndex === null &&
      value.parseStatus === null;
    const complete =
      CHRONICLE_STAGE_IDS.has(value.stageId) &&
      Number.isSafeInteger(value.invocationIndex) &&
      value.invocationIndex >= 0 &&
      value.invocationIndex < SOURCE_DIAGNOSTICS_MAX_INVOCATIONS_PER_CASE &&
      (value.parseStatus === null ||
        CHRONICLE_PARSE_STATUSES.has(value.parseStatus));
    if (!absent && !complete) rejectFailureDiagnostics();
    const comparison = {
      kind: value.kind,
      stageId: value.stageId,
      invocationIndex: value.invocationIndex,
      parseStatus: value.parseStatus,
    };
    return {
      comparison,
      artifact: {
        code: value.kind,
        stageId: value.stageId,
        invocationIndex: value.invocationIndex,
        parseStatus: value.parseStatus,
      },
    };
  }
  if (value.kind === "diagnostic-parity-failure") {
    const dispatchCount = boundedCount(value.dispatchCount);
    const diagnosticCount = boundedCount(value.diagnosticCount);
    if (
      dispatchCount > SOURCE_DIAGNOSTICS_MAX_INVOCATIONS_PER_CASE ||
      diagnosticCount > SOURCE_DIAGNOSTICS_MAX_INVOCATIONS_PER_CASE ||
      !Array.isArray(value.dispatchKeys) ||
      !Array.isArray(value.diagnosticKeys) ||
      dispatchCount !== value.dispatchKeys.length ||
      diagnosticCount !== value.diagnosticKeys.length
    ) {
      rejectFailureDiagnostics();
    }
    const dispatchKeys = value.dispatchKeys.map(parseInvocationKey);
    const diagnosticKeys = value.diagnosticKeys.map(parseInvocationKey);
    if (
      dispatchKeys.length === diagnosticKeys.length &&
      dispatchKeys.every((key, index) => key === diagnosticKeys[index])
    ) {
      rejectFailureDiagnostics();
    }
    return {
      comparison: {
        kind: value.kind,
        dispatchCount,
        diagnosticCount,
        dispatchKeys,
        diagnosticKeys,
      },
      artifact: { code: value.kind, dispatchCount, diagnosticCount },
    };
  }
  rejectFailureDiagnostics();
}

function validateChronicleSourceReportForDiagnostics(report, expected) {
  if (!isRecord(report)) rejectFailureDiagnostics("source-report-invalid");
  try {
    const binding = validateHeavyReportBinding(report, expected, expected);
    const protocol = validateCurrentNarrativeEvalProtocolBinding(report);
    const accounting = validateChronicleProductionCaseAccounting(report);
    const structurallyValidTechnicalFailure =
      !accounting.ok &&
      /^Chronicle scored cases contain [1-9]\d* certification-disqualifying evaluation\(s\)$/.test(
        accounting.message,
      );
    if (
      !binding.ok ||
      !protocol.ok ||
      (!accounting.ok && !structurallyValidTechnicalFailure) ||
      report.mode !== "chronicle-production-live" ||
      report.attempt !== 1 ||
      report.diagnosticOnly !== false
    ) {
      rejectFailureDiagnostics("source-report-invalid");
    }
  } catch (error) {
    if (error instanceof FailureDiagnosticsSourceError) throw error;
    rejectFailureDiagnostics("source-report-invalid");
  }
}

function projectChronicleFailureDiagnostics(source, report, expected) {
  validateChronicleSourceReportForDiagnostics(report, expected);
  if (!isRecord(source)) rejectFailureDiagnostics();
  if (
    source.runId !== expected.runId ||
    source.candidateCommitSha !== expected.commitSha ||
    source.candidateTreeSha !== expected.treeSha ||
    source.qualityEvaluationSuiteId !== expected.suiteId ||
    source.commandDigest !== expected.commandDigest ||
    source.attempt !== expected.attempt ||
    source.evidenceMode !== CURRENT_NARRATIVE_EVAL_PROTOCOL.evidenceMode ||
    source.receiptMode !== CURRENT_NARRATIVE_EVAL_PROTOCOL.receiptMode
  ) {
    rejectFailureDiagnostics("source-binding-mismatch");
  }
  if (
    source.schemaVersion !== 1 ||
    source.mode !== "chronicle-production-live-diagnostics" ||
    source.nonAuthoritative !== true ||
    source.diagnosticOnly !== true ||
    source.certificationEligible !== false ||
    source.caseCount !== CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.length ||
    !Array.isArray(source.cases) ||
    source.cases.length !== CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.length
  ) {
    rejectFailureDiagnostics();
  }

  const reportCases = new Map(
    [...report.cases, ...report.failedCases].map((entry) => [
      entry.caseId,
      entry,
    ]),
  );
  const failedCaseIds = new Set(
    report.failedCases.map((entry) => entry.caseId),
  );
  const projectedCases = [];
  let invalidDiagnosticCount = 0;
  for (const [
    caseIndex,
    caseId,
  ] of CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.entries()) {
    const sourceCase = source.cases[caseIndex];
    const reportCase = reportCases.get(caseId);
    if (
      !isRecord(sourceCase) ||
      !isRecord(reportCase) ||
      sourceCase.caseId !== caseId
    ) {
      rejectFailureDiagnostics("source-binding-mismatch");
    }
    const sourceProtocol =
      validateCurrentNarrativeEvalProtocolBinding(sourceCase);
    if (
      !sourceProtocol.ok ||
      sourceCase.evidenceMode !== reportCase.evidenceMode ||
      sourceCase.receiptMode !== reportCase.receiptMode ||
      Object.keys(CURRENT_NARRATIVE_EVAL_PROTOCOL.versions).some(
        (key) => sourceCase.versions[key] !== reportCase.versions[key],
      ) ||
      !SHA256_RE.test(sourceCase.corpusDigest) ||
      sourceCase.corpusDigest !== reportCase.corpusDigest ||
      !SHA256_RE.test(sourceCase.fixturePromptDigest) ||
      sourceCase.fixturePromptDigest !== reportCase.fixturePromptDigest
    ) {
      rejectFailureDiagnostics("source-binding-mismatch");
    }
    if (
      !Array.isArray(sourceCase.dispatches) ||
      !Array.isArray(reportCase.dispatches) ||
      sourceCase.dispatches.length >
        SOURCE_DIAGNOSTICS_MAX_INVOCATIONS_PER_CASE ||
      sourceCase.dispatches.length !== reportCase.dispatches.length ||
      !Array.isArray(sourceCase.stageDiagnostics) ||
      sourceCase.stageDiagnostics.length >
        SOURCE_DIAGNOSTICS_MAX_INVOCATIONS_PER_CASE
    ) {
      rejectFailureDiagnostics("source-parity-mismatch");
    }

    const dispatches = [];
    const nextInvocationIndex = new Map();
    for (const [dispatchIndex, dispatch] of sourceCase.dispatches.entries()) {
      const reportDispatch = reportCase.dispatches[dispatchIndex];
      if (!isRecord(dispatch) || !isRecord(reportDispatch)) {
        rejectFailureDiagnostics();
      }
      const stageId = fixedEnum(dispatch.stageId, CHRONICLE_STAGE_IDS);
      const invocationIndex = boundedInvocationIndex(dispatch.invocationIndex);
      if (invocationIndex !== (nextInvocationIndex.get(stageId) ?? 0)) {
        rejectFailureDiagnostics("source-parity-mismatch");
      }
      nextInvocationIndex.set(stageId, invocationIndex + 1);
      if (
        !SHA256_RE.test(dispatch.promptDigest) ||
        !SHA256_RE.test(dispatch.responseDigest)
      ) {
        rejectFailureDiagnostics();
      }
      if (
        dispatch.promptDigest !== reportDispatch.promptDigest ||
        dispatch.responseDigest !== reportDispatch.responseDigest
      ) {
        rejectFailureDiagnostics("source-parity-mismatch");
      }
      const finishReason =
        dispatch.finishReason === null
          ? null
          : fixedEnum(dispatch.finishReason, CHRONICLE_FINISH_REASONS);
      const stopReason = fixedEnum(dispatch.stopReason, CHRONICLE_STOP_REASONS);
      dispatches.push({
        key: `${stageId}:${invocationIndex}`,
        projected: {
          stageId,
          invocationIndex,
          promptTextDigest: dispatch.promptDigest,
          responseTextDigest: dispatch.responseDigest,
          finishReason,
          stopReason,
        },
      });
    }

    const diagnostics = sourceCase.stageDiagnostics.map(projectStageDiagnostic);
    const dispatchKeys = dispatches.map((entry) => entry.key);
    const diagnosticKeys = diagnostics.map((entry) => entry.key);
    if (
      new Set(dispatchKeys).size !== dispatchKeys.length ||
      new Set(diagnosticKeys).size !== diagnosticKeys.length
    ) {
      rejectFailureDiagnostics("source-parity-mismatch");
    }

    const sourceTerminal = projectTerminalFailure(sourceCase.terminalFailure);
    const reportTerminal = projectTerminalFailure(reportCase.terminalFailure);
    if (
      Boolean(sourceTerminal) !== failedCaseIds.has(caseId) ||
      Boolean(reportTerminal) !== failedCaseIds.has(caseId) ||
      JSON.stringify(sourceTerminal?.comparison) !==
        JSON.stringify(reportTerminal?.comparison)
    ) {
      rejectFailureDiagnostics("source-parity-mismatch");
    }
    const keysMatch =
      dispatchKeys.length === diagnosticKeys.length &&
      dispatchKeys.every((key, index) => key === diagnosticKeys[index]);
    if (sourceTerminal?.comparison.kind === "diagnostic-parity-failure") {
      if (
        keysMatch ||
        JSON.stringify(dispatchKeys) !==
          JSON.stringify(sourceTerminal.comparison.dispatchKeys) ||
        JSON.stringify(diagnosticKeys) !==
          JSON.stringify(sourceTerminal.comparison.diagnosticKeys)
      ) {
        rejectFailureDiagnostics("source-parity-mismatch");
      }
    } else if (!keysMatch) {
      rejectFailureDiagnostics("source-parity-mismatch");
    }

    const caseInvalidDiagnosticCount = diagnostics.filter(
      (entry) => entry.projected.parseStatus === "invalid",
    ).length;
    invalidDiagnosticCount += caseInvalidDiagnosticCount;
    if (
      !failedCaseIds.has(caseId) &&
      reportCase.evaluation.parseFailureCount !== caseInvalidDiagnosticCount
    ) {
      rejectFailureDiagnostics("source-parity-mismatch");
    }
    const dispatchByKey = new Map(
      dispatches.map((entry) => [entry.key, entry]),
    );
    const invocations = diagnostics.flatMap((diagnostic) => {
      const dispatch = dispatchByKey.get(diagnostic.key);
      return diagnostic.relevant && dispatch
        ? [{ ...dispatch.projected, ...diagnostic.projected }]
        : [];
    });
    if (invocations.length > 0 || sourceTerminal) {
      projectedCases.push({
        caseId,
        invocations,
        ...(sourceTerminal ? { terminalFailure: sourceTerminal.artifact } : {}),
      });
    }
  }
  if (invalidDiagnosticCount !== report.summary.parseFailureCount) {
    rejectFailureDiagnostics("source-parity-mismatch");
  }
  if (projectedCases.length === 0) {
    rejectFailureDiagnostics();
  }
  return {
    schemaVersion: 1,
    mode: "live-model-qualification-failure-diagnostics",
    nonAuthoritative: true,
    diagnosticOnly: true,
    certificationEligible: false,
    runId: expected.runId,
    suiteId: expected.suiteId,
    cases: projectedCases,
  };
}

async function collectChronicleFailureDiagnostics({
  target,
  report,
  expected,
}) {
  const loaded = await readBoundedSourceDiagnostics(target);
  if (!loaded.ok) return { artifact: null, reason: loaded.reason };
  try {
    return {
      artifact: projectChronicleFailureDiagnostics(
        loaded.value,
        report,
        expected,
      ),
      reason: null,
    };
  } catch (error) {
    const reason =
      error instanceof FailureDiagnosticsSourceError &&
      FAILURE_DIAGNOSTICS_UNAVAILABLE_REASONS.has(error.reason)
        ? error.reason
        : "source-invalid";
    return { artifact: null, reason };
  }
}

async function allocateRunDirectory({ artifactRoot, candidateSha, runId }) {
  const candidateDir = path.join(artifactRoot, candidateSha);
  await mkdir(candidateDir, { recursive: true });
  const runDir = path.join(candidateDir, runId);
  await mkdir(runDir, { mode: 0o700 });
  await mkdir(path.join(runDir, "suites"), { mode: 0o700 });
  return runDir;
}

async function writeJsonExclusive(target, document) {
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function persistFailureDiagnostics({ suiteDir, artifact, secrets }) {
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const target = path.join(suiteDir, FAILURE_DIAGNOSTICS_FILE);
  let handle = null;
  let created = false;
  try {
    if (
      bytes.length > SOURCE_DIAGNOSTICS_MAX_BYTES ||
      secrets.some((secret) => secret && bytes.includes(secret))
    ) {
      throw new Error("failure diagnostics projection rejected");
    }
    handle = await open(target, "wx", 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.close();
    handle = null;
    return { failureDiagnosticsDigest: sha256Buffer(bytes) };
  } catch {
    await handle?.close().catch(() => {});
    if (created) {
      // The wx open proves ownership. Never unlink an EEXIST target that this
      // invocation did not create.
      await rm(target, { force: true }).catch(() => {});
    }
    return {
      failureDiagnosticsUnavailableReason: "projection-persist-failed",
    };
  }
}

function capturedFailure(error, startedAt, completedAt) {
  const stderr = Buffer.from(String(error?.stack ?? error?.message ?? error));
  const stdout = Buffer.alloc(0);
  return {
    status: "failed",
    exitCode: null,
    error: error?.message ?? String(error),
    startedAt,
    completedAt,
    stdout,
    stderr,
    stdoutDigest: sha256Buffer(stdout),
    stderrDigest: sha256Buffer(stderr),
  };
}

export function classifyChronicleQualificationReport(
  report,
  expected,
  captured,
) {
  if (!report) {
    return {
      result: "FAILED",
      message: "Chronicle structured report was not produced",
    };
  }
  const binding = validateHeavyReportBinding(report, expected, expected);
  if (!binding.ok) return { result: "FAILED", message: binding.message };
  const protocol = validateCurrentNarrativeEvalProtocolBinding(report);
  if (!protocol.ok) return { result: "FAILED", message: protocol.message };
  if (report.mode !== "chronicle-production-live") {
    return { result: "FAILED", message: "Chronicle report mode is invalid" };
  }
  if (report.diagnosticOnly === true || report.attempt !== 1) {
    return {
      result: "FAILED",
      message: "Chronicle qualification requires a full attempt 1 report",
    };
  }
  const accounting = validateChronicleProductionCaseAccounting(report);
  if (!accounting.ok) return { result: "FAILED", message: accounting.message };
  if (report.summary.parseFailureCount > 0) {
    return {
      result: "FAILED",
      message: `Chronicle parser failures: ${report.summary.parseFailureCount}`,
    };
  }
  if (accounting.terminalFailureCount > 0) {
    return {
      result: "FAILED",
      message: `Chronicle report contains ${accounting.terminalFailureCount} terminal failed case(s)`,
    };
  }
  if (report.certificationEligible === true) {
    const certificationAccounting =
      validateChronicleProductionCertificationAccounting(report, accounting);
    if (!certificationAccounting.ok) {
      return { result: "FAILED", message: certificationAccounting.message };
    }
    if (captured?.status !== "passed" || captured?.exitCode !== 0) {
      return {
        result: "FAILED",
        message: `Chronicle harness exited ${captured?.exitCode ?? "without a code"}`,
      };
    }
    return {
      result: "QUALIFIED",
      message: "Chronicle semantic thresholds satisfied",
    };
  }
  if (
    report.certificationEligible === false &&
    captured?.status === "failed" &&
    captured?.exitCode === 1 &&
    accounting.scoredCaseCount === 14 &&
    accounting.passedCaseCount < 14 &&
    accounting.failedCaseCount > 0 &&
    accounting.terminalFailureCount === 0 &&
    report.summary.parseFailureCount === 0
  ) {
    return {
      result: "HOLD",
      message:
        "Chronicle ran successfully but semantic thresholds were not met",
    };
  }
  return {
    result: "FAILED",
    message:
      "Chronicle report was not qualification-eligible after complete current scoring",
  };
}

export function deriveQualificationResult(suites) {
  if (suites.some((suite) => suite.result === "FAILED")) return "FAILED";
  if (suites.some((suite) => suite.result === "HOLD")) return "HOLD";
  if (
    suites.length > 0 &&
    suites.every((suite) => suite.result === "QUALIFIED")
  ) {
    return "QUALIFIED";
  }
  return "INCOMPLETE";
}

function incompleteReport({
  manifestDigest,
  runId,
  candidate,
  provider,
  model,
  reasoningEffort,
  selectedSuites,
  startedAt,
  reasons,
  completedAt,
}) {
  return {
    schemaVersion: 1,
    qualificationId: "grimodex-live-model-qualification",
    manifestDigest,
    runId,
    candidate,
    configuration: { provider, model, reasoningEffort },
    selectedSuites,
    startedAt,
    completedAt,
    result: "INCOMPLETE",
    reasons,
    suites: [],
  };
}

async function persistTopReport({ report, schema, runDir, secrets }) {
  const validation = validateAgainstSchema(report, schema);
  if (!validation.ok) {
    throw new Error(
      `Live qualification report schema validation failed: ${JSON.stringify(validation.errors)}`,
    );
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) {
      throw new Error("Credential value reached the qualification report");
    }
  }
  const reportPath = path.join(runDir, "report.json");
  await writeFile(reportPath, serialized, { encoding: "utf8", flag: "wx" });
  return reportPath;
}

export async function runLiveModelQualification({
  repoRoot = DEFAULT_REPO_ROOT,
  args,
  env = process.env,
  executeCommand = runShellStringCommand,
  candidateResolver = resolveQualificationCandidate,
  idFactory = randomUUID,
  now = () => new Date(),
  onWarning = (message) => process.stderr.write(`Warning: ${message}\n`),
} = {}) {
  if (String(env.GITHUB_ACTIONS).toLowerCase() === "true") {
    throw new Error(
      "Live Model Qualification is maintainer-local and refuses GitHub Actions",
    );
  }
  if (!args) throw new Error("qualification arguments are required");

  const model = await loadQualificationModel(repoRoot, args.manifest);
  const { manifest, manifestDigest, qualityIndex, schema } = model;
  const selectedSuites =
    args.suites.length > 0 ? [...args.suites] : [...manifest.defaultProfile];
  const policies = new Map(
    manifest.qualificationSuites.map((entry) => [entry.id, entry]),
  );
  for (const suiteId of selectedSuites) {
    if (!policies.has(suiteId)) {
      throw new Error(
        `Suite is not allowed by the qualification profile: ${suiteId}`,
      );
    }
    if (!qualityIndex.heavy.get(suiteId)?.command) {
      throw new Error(
        `Suite is missing from Quality Manifest Heavy commands: ${suiteId}`,
      );
    }
  }
  const provider = args.provider ?? manifest.provider;
  if (provider !== manifest.provider) {
    throw new Error(`Unsupported qualification provider: ${provider}`);
  }
  if (
    args.reasoningEffort &&
    !manifest.allowedReasoningEfforts.includes(args.reasoningEffort)
  ) {
    throw new Error(`Unsupported reasoning effort: ${args.reasoningEffort}`);
  }

  const candidate = await candidateResolver(repoRoot, args.candidate);
  const startedAt = now().toISOString();
  const runId = qualificationRunId(startedAt, idFactory);
  const artifactRoot = resolveRepoPath(
    repoRoot,
    args.artifactRoot ?? manifest.artifactRoot,
  );
  const runDir = await allocateRunDirectory({
    artifactRoot,
    candidateSha: candidate.commitSha,
    runId,
  });
  const credentialEnvironment = [
    ...new Set([
      ...manifest.requiredEnvironment,
      ...AI_PROVIDER_CREDENTIAL_ENV_NAMES,
      ...credentialEnvironmentNames(env),
    ]),
  ];
  const secretValues = credentialEnvironment
    .map((name) => env[name])
    .filter(nonEmpty);

  const missingInputs = [];
  if (!nonEmpty(args.model)) missingInputs.push("--model");
  if (!nonEmpty(args.reasoningEffort)) {
    missingInputs.push("--reasoning-effort");
  }
  if (candidate.dirty && !args.allowDirty) {
    onWarning(
      "working tree is dirty; qualification is refused unless --allow-dirty is explicit",
    );
    missingInputs.push("clean working tree");
  } else if (candidate.dirty) {
    onWarning(
      "working tree is dirty; candidate commit/tree do not include uncommitted changes",
    );
  }
  const missingEnvironment = manifest.requiredEnvironment.filter(
    (name) => !nonEmpty(env[name]),
  );
  if (missingEnvironment.length > 0) {
    missingInputs.push(`environment: ${missingEnvironment.join(", ")}`);
  }
  if (missingInputs.length > 0) {
    const report = incompleteReport({
      manifestDigest,
      runId,
      candidate,
      provider,
      model: nonEmpty(args.model) ? args.model : null,
      reasoningEffort: nonEmpty(args.reasoningEffort)
        ? args.reasoningEffort
        : null,
      selectedSuites,
      startedAt,
      completedAt: now().toISOString(),
      reasons: [
        `Missing qualification prerequisites: ${missingInputs.join("; ")}`,
      ],
    });
    const reportPath = await persistTopReport({
      report,
      schema,
      runDir,
      secrets: secretValues,
    });
    return { report, reportPath, runDir };
  }

  const suites = [];
  for (const suiteId of selectedSuites) {
    const policy = policies.get(suiteId);
    const resolved = await resolveHeavyCommand({
      entry: { qualityManifestId: suiteId },
      qualityIndex,
      packageJson: null,
    });
    if (!resolved.available || resolved.kind !== "shell-string") {
      throw new Error(`Unable to resolve qualification suite ${suiteId}`);
    }
    const commandString = stripCommandEnvironmentAssignments(
      stripCredentialPlaceholders(resolved.commandString),
      [
        "OPENROUTER_MODEL",
        "OPENROUTER_REASONING_EFFORT",
        "NARRATIVE_EVAL_EVIDENCE_MODE",
      ],
    );
    const commandDigest = sha256Text(JSON.stringify([commandString]));
    const expected = {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      suiteId,
      runId,
      commandDigest,
      attempt: 1,
    };
    const suiteDir = path.join(runDir, "suites", suiteId);
    await mkdir(suiteDir, { mode: 0o700 });
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-live-qualification-"),
    );
    const rawReportPath = path.join(tempDir, "source-report.json");
    const suiteStartedAt = now().toISOString();
    const childEnv = {
      ...sanitizeEvaluationEnv(env, {
        remove: [
          ...CHILD_ENV_REMOVALS,
          ...credentialEnvironment.filter(
            (name) => name !== "OPENROUTER_API_KEY",
          ),
        ],
      }),
      OPENROUTER_MODEL: args.model,
      OPENROUTER_REASONING_EFFORT: args.reasoningEffort,
      NARRATIVE_EVAL_EVIDENCE_MODE:
        CURRENT_NARRATIVE_EVAL_PROTOCOL.evidenceMode,
      QUALITY_EVALUATION_PROVIDER: provider,
      QUALITY_EVALUATION_MODEL: args.model,
      QUALITY_EVALUATION_REASONING_EFFORT: args.reasoningEffort,
      QUALITY_EVALUATION_CANDIDATE_COMMIT_SHA: candidate.commitSha,
      QUALITY_EVALUATION_CANDIDATE_TREE_SHA: candidate.treeSha,
      QUALITY_EVALUATION_SUITE_ID: suiteId,
      QUALITY_EVALUATION_RUN_ID: runId,
      QUALITY_EVALUATION_COMMAND_DIGEST: commandDigest,
      QUALITY_EVALUATION_OUTPUT_PATH: rawReportPath,
      QUALITY_EVALUATION_ARTIFACT_ROOT: tempDir,
    };
    let captured;
    let sourceReport = null;
    let sourceReportError = null;
    let failureDiagnostics = null;
    try {
      try {
        captured = await executeCommand(commandString, repoRoot, childEnv);
      } catch (error) {
        captured = capturedFailure(error, suiteStartedAt, now().toISOString());
      }
      try {
        sourceReport = JSON.parse(await readFile(rawReportPath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") sourceReportError = error;
      }
      if (policy.resultPolicy === "chronicle-semantic") {
        failureDiagnostics = await collectChronicleFailureDiagnostics({
          target: path.join(tempDir, runId, "diagnostics.json"),
          report: sourceReport,
          expected,
        });
      }
    } finally {
      // Raw provider-capable reports are ephemeral. Only the bounded,
      // allowlisted diagnostics projection may survive this cleanup.
      await rm(tempDir, { recursive: true, force: true });
    }
    const stdout = sanitizeCapturedBuffer(captured.stdout ?? "", secretValues);
    const stderr = sanitizeCapturedBuffer(captured.stderr ?? "", secretValues);
    const stdoutDigest = sha256Buffer(stdout);
    const stderrDigest = sha256Buffer(stderr);
    await writeFile(path.join(suiteDir, "stdout.log"), stdout, { flag: "wx" });
    await writeFile(path.join(suiteDir, "stderr.log"), stderr, { flag: "wx" });
    const sanitizedSourceReport = sourceReport
      ? sanitizeStructuredArtifact(sourceReport, secretValues)
      : null;
    const sanitizedArtifactDigest = sha256Text(
      JSON.stringify({ stdoutDigest, stderrDigest, sanitizedSourceReport }),
    );

    let classification;
    if (sourceReportError) {
      classification = {
        result: "FAILED",
        message: `Structured report parse failed: ${sourceReportError.message}`,
      };
    } else if (policy.resultPolicy === "chronicle-semantic") {
      classification = classifyChronicleQualificationReport(
        sourceReport,
        expected,
        captured,
      );
    } else if (captured.status === "passed") {
      classification = {
        result: "QUALIFIED",
        message: "Suite completed successfully",
      };
    } else {
      classification = {
        result: "FAILED",
        message: captured.error ?? `Suite exited ${captured.exitCode}`,
      };
    }
    let failureDiagnosticsFields = {};
    if (
      classification.result === "FAILED" &&
      policy.resultPolicy === "chronicle-semantic"
    ) {
      if (failureDiagnostics?.artifact) {
        failureDiagnosticsFields = await persistFailureDiagnostics({
          suiteDir,
          artifact: failureDiagnostics.artifact,
          secrets: secretValues,
        });
      } else {
        failureDiagnosticsFields = {
          failureDiagnosticsUnavailableReason:
            failureDiagnostics?.reason ?? "source-missing",
        };
      }
    }
    const suiteReport = {
      suiteId,
      startedAt: captured.startedAt ?? suiteStartedAt,
      completedAt: captured.completedAt ?? now().toISOString(),
      exitCode: captured.exitCode ?? null,
      commandDigest,
      stdoutDigest,
      stderrDigest,
      sanitizedArtifactDigest,
      result: classification.result,
      message: sanitizeCapturedText(classification.message, secretValues),
      ...failureDiagnosticsFields,
    };
    await writeJsonExclusive(path.join(suiteDir, "report.json"), suiteReport);
    suites.push(suiteReport);
  }

  const result = deriveQualificationResult(suites);
  const report = {
    schemaVersion: 1,
    qualificationId: "grimodex-live-model-qualification",
    manifestDigest,
    runId,
    candidate,
    configuration: {
      provider,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
    },
    selectedSuites,
    startedAt,
    completedAt: now().toISOString(),
    result,
    reasons: suites
      .filter((suite) => suite.result !== "QUALIFIED")
      .map((suite) => `${suite.suiteId}: ${suite.message}`),
    suites,
  };
  const reportPath = await persistTopReport({
    report,
    schema,
    runDir,
    secrets: secretValues,
  });
  return { report, reportPath, runDir };
}

export function qualificationExitCode(report) {
  return report.result === "QUALIFIED" ? 0 : 1;
}

export function formatQualificationMarkdown(report, reportPath) {
  return [
    "# Live Model Qualification",
    "",
    `- result: **${report.result}**`,
    `- candidate: \`${report.candidate.commitSha}\``,
    `- model: \`${report.configuration.provider}/${report.configuration.model}\``,
    `- reasoning effort: \`${report.configuration.reasoningEffort}\``,
    `- report: \`${reportPath}\``,
    "",
    ...report.suites.map((suite) => `- \`${suite.suiteId}\` → ${suite.result}`),
    "",
  ].join("\n");
}

async function main() {
  const args = parseLiveModelQualificationArgs(process.argv.slice(2));
  const result = await runLiveModelQualification({ args });
  process.stdout.write(
    args.format === "json"
      ? `${JSON.stringify(result.report, null, 2)}\n`
      : formatQualificationMarkdown(result.report, result.reportPath),
  );
  process.exitCode = qualificationExitCode(result.report);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
