/**
 * Shared process/runtime helpers for quality evaluations.
 *
 * This module deliberately contains no Gate B2 or local-qualification
 * authority policy. Callers share command resolution, capture, sanitization,
 * and report validation while retaining separate execution permissions.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";

const PLACEHOLDER_ENV_ASSIGN = /\b([A-Z][A-Z0-9_]*)=\.\.\.(\s+)/g;
export const AI_PROVIDER_CREDENTIAL_ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "OPEN_ROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_ACCESS_TOKEN",
];
// Corpus/protocol selectors are caller-controlled for maintainer-local
// diagnostics, but must never leak into a certification or qualification
// child. Keep this list shared with the local qualification runner so both
// execution paths scrub the same ambient overrides.
export const NARRATIVE_EVAL_SELECTOR_ENV_NAMES = Object.freeze([
  "NARRATIVE_EVAL_SUITE_ID",
  "NARRATIVE_EVAL_EVIDENCE_MODE",
]);

export const CURRENT_NARRATIVE_EVAL_PROTOCOL_RELATIVE_PATH =
  "evals/qualifications/narrative-current-protocol-v2.json";

const CURRENT_NARRATIVE_EVAL_PROTOCOL_ID =
  "grimodex-narrative-current-protocol";
const CURRENT_NARRATIVE_EVAL_PROTOCOL_SCHEMA_VERSION = 1;
const CURRENT_NARRATIVE_EVIDENCE_MODE = "citation-id-v2";
const NARRATIVE_EVAL_VERSION_KEYS = Object.freeze([
  "prompt",
  "responseSchema",
  "extractor",
  "parser",
]);

// The Chronicle production certification suite is the canonical
// chronicle-micro-v1 corpus. Keep its case identity bound at this boundary so
// a report cannot replace the expected set with duplicate or invented IDs
// while preserving the aggregate count. The source corpus and its manifest
// remain authoritative for the case definitions and count.
export const CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS = Object.freeze([
  "chronicle.micro.actual-gate-collapse-001",
  "chronicle.micro.plan-only-002",
  "chronicle.micro.rumor-only-003",
  "chronicle.micro.blocked-attempt-004",
  "chronicle.micro.dream-only-005",
  "chronicle.micro.hypothetical-only-006",
  "chronicle.micro.flashback-actual-007",
  "chronicle.micro.duplicate-mention-008",
  "chronicle.micro.non-event-description-009",
  "chronicle.micro.exact-quote-selection-010",
  "chronicle.micro.negated-event-011",
  "chronicle.micro.disputed-attribution-012",
  "chronicle.micro.partial-coverage-013",
  "chronicle.micro.significance-gate-014",
]);

export const CHRONICLE_PRODUCTION_EXPECTED_DIMENSION_KEYS = Object.freeze([
  "eventDetection",
  "actuality",
  "attribution",
  "narrativeFrame",
  "evidence",
  "clustering",
  "significance",
  "proposalGate",
]);

export const CHRONICLE_PRODUCTION_DIMENSION_SCORE_KEYS = Object.freeze([
  "truePositive",
  "falsePositive",
  "falseNegative",
  "unobservable",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate the immutable current Narrative protocol declaration itself.
 * Legacy mode is intentionally not a valid current declaration; it has its
 * own explicit diagnostic/historical readers.
 */
export function validateCurrentNarrativeEvalProtocol(protocol) {
  const errors = [];
  if (!isRecord(protocol)) return ["protocol must be an object"];
  if (
    protocol.schemaVersion !== CURRENT_NARRATIVE_EVAL_PROTOCOL_SCHEMA_VERSION
  ) {
    errors.push(
      `schemaVersion must be ${CURRENT_NARRATIVE_EVAL_PROTOCOL_SCHEMA_VERSION}`,
    );
  }
  if (protocol.id !== CURRENT_NARRATIVE_EVAL_PROTOCOL_ID) {
    errors.push(`id must be ${CURRENT_NARRATIVE_EVAL_PROTOCOL_ID}`);
  }
  if (protocol.evidenceMode !== CURRENT_NARRATIVE_EVIDENCE_MODE) {
    errors.push(
      `evidenceMode must be ${CURRENT_NARRATIVE_EVIDENCE_MODE} for the current protocol`,
    );
  }
  if (protocol.receiptMode !== CURRENT_NARRATIVE_EVIDENCE_MODE) {
    errors.push(
      `receiptMode must be ${CURRENT_NARRATIVE_EVIDENCE_MODE} for the current protocol`,
    );
  }
  if (!isRecord(protocol.versions)) {
    errors.push("versions must be an object");
  } else {
    for (const key of NARRATIVE_EVAL_VERSION_KEYS) {
      if (
        typeof protocol.versions[key] !== "string" ||
        protocol.versions[key].trim().length === 0
      ) {
        errors.push(`versions.${key} must be a non-empty string`);
      }
    }
    const unexpected = Object.keys(protocol.versions).filter(
      (key) => !NARRATIVE_EVAL_VERSION_KEYS.includes(key),
    );
    if (unexpected.length > 0) {
      errors.push(`versions contains unknown keys: ${unexpected.join(", ")}`);
    }
  }
  const unexpected = Object.keys(protocol).filter(
    (key) =>
      ![
        "schemaVersion",
        "id",
        "evidenceMode",
        "receiptMode",
        "versions",
      ].includes(key),
  );
  if (unexpected.length > 0) {
    errors.push(`protocol contains unknown keys: ${unexpected.join(", ")}`);
  }
  return errors;
}

const currentProtocolSource = JSON.parse(
  readFileSync(
    new URL(
      `../../${CURRENT_NARRATIVE_EVAL_PROTOCOL_RELATIVE_PATH}`,
      import.meta.url,
    ),
    "utf8",
  ),
);
const currentProtocolErrors = validateCurrentNarrativeEvalProtocol(
  currentProtocolSource,
);
if (currentProtocolErrors.length > 0) {
  throw new Error(
    `Invalid current Narrative evaluation protocol:\n- ${currentProtocolErrors.join("\n- ")}`,
  );
}

export const CURRENT_NARRATIVE_EVAL_PROTOCOL = freezeDeep(
  currentProtocolSource,
);

/**
 * Bind a Chronicle report to the current protocol declaration. This is kept
 * separate from legacy report readers so a historical report cannot silently
 * become evidence for a current qualification or certification run.
 */
export function validateCurrentNarrativeEvalProtocolBinding(
  report,
  expected = CURRENT_NARRATIVE_EVAL_PROTOCOL,
) {
  if (!isRecord(report)) {
    return { ok: false, message: "Narrative report must be an object" };
  }
  if (!isRecord(expected)) {
    return { ok: false, message: "current Narrative protocol is invalid" };
  }
  if (report.evidenceMode !== expected.evidenceMode) {
    return {
      ok: false,
      message: `report evidenceMode mismatch (expected ${expected.evidenceMode})`,
    };
  }
  if (report.receiptMode !== expected.receiptMode) {
    return {
      ok: false,
      message: `report receiptMode mismatch (expected ${expected.receiptMode})`,
    };
  }
  if (!isRecord(report.versions)) {
    return { ok: false, message: "report versions are missing" };
  }
  if (!isRecord(expected.versions)) {
    return {
      ok: false,
      message: "current Narrative protocol versions are invalid",
    };
  }
  for (const key of NARRATIVE_EVAL_VERSION_KEYS) {
    if (report.versions[key] !== expected.versions[key]) {
      return {
        ok: false,
        message: `report versions.${key} mismatch (expected ${expected.versions[key]})`,
      };
    }
  }
  const unexpected = Object.keys(report.versions).filter(
    (key) => !NARRATIVE_EVAL_VERSION_KEYS.includes(key),
  );
  if (unexpected.length > 0) {
    return {
      ok: false,
      message: `report versions contain unknown keys: ${unexpected.join(", ")}`,
    };
  }
  return { ok: true, message: "current Narrative protocol accepted" };
}
const CERTIFICATION_ENV_REMOVALS = [
  "NARRATIVE_EVAL_LIMIT",
  "NARRATIVE_EVAL_CASE_ID",
  "NARRATIVE_EVAL_ATTEMPT",
  ...NARRATIVE_EVAL_SELECTOR_ENV_NAMES,
  // Bootstrap authority belongs only to the bound certification runner. A
  // Light/Heavy/Journey child must never inherit it and appear pre-authorized.
  "GATE_B2_BOUND_EXECUTION",
  "GATE_B2_FREEZE_PATH",
  ...AI_PROVIDER_CREDENTIAL_ENV_NAMES,
];

export function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function sha256Buffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

/** Remove `VAR=...` placeholder assignments so parent env values are used. */
export function stripCredentialPlaceholders(commandString) {
  return String(commandString).replace(PLACEHOLDER_ENV_ASSIGN, "");
}

/**
 * Remove trusted-manifest environment assignments that a caller overrides via
 * the child environment. Values are never interpolated into the shell string.
 */
export function stripCommandEnvironmentAssignments(commandString, names) {
  let result = String(commandString);
  for (const name of names) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const assignment = new RegExp(
      `(^|\\s)${escaped}=(?:"[^"]*"|'[^']*'|\\S+)\\s*`,
      "g",
    );
    result = result.replace(assignment, "$1");
  }
  return result.trim();
}

export function sanitizeEvaluationEnv(
  baseEnv = process.env,
  { remove = [] } = {},
) {
  const env = { ...baseEnv };
  for (const name of remove) delete env[name];
  return env;
}

export function sanitizeCertificationEnv(baseEnv = process.env) {
  return sanitizeEvaluationEnv(baseEnv, {
    remove: CERTIFICATION_ENV_REMOVALS,
  });
}

/**
 * Redact known credential values and common transport credential forms before
 * any captured output is persisted. The raw child environment is never logged.
 */
export function sanitizeCapturedText(value, secrets = []) {
  let text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const knownSecrets = [...new Set(secrets)]
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .flatMap((secret) => [secret, encodeURIComponent(secret)])
    .sort((left, right) => right.length - left.length);
  for (const secret of knownSecrets) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/(authorization\s*[:=]\s*)([^\r\n]+)/gi, "$1[REDACTED]")
    .replace(/((?:x-)?api[-_ ]?key\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[REDACTED]@");
}

export function sanitizeCapturedBuffer(value, secrets = []) {
  return Buffer.from(sanitizeCapturedText(value, secrets), "utf8");
}

const CREDENTIAL_FIELD_PATTERN =
  /(?:authorization|api[-_]?key|access[-_]?token|credential|password|secret)/i;

export function sanitizeStructuredArtifact(value, secrets = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeStructuredArtifact(entry, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        CREDENTIAL_FIELD_PATTERN.test(key)
          ? "[REDACTED]"
          : sanitizeStructuredArtifact(entry, secrets),
      ]),
    );
  }
  if (typeof value === "string") {
    return sanitizeCapturedText(value, secrets);
  }
  return value;
}

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function capturedResult({
  started,
  startedAt,
  stdout,
  stderr,
  exitCode,
  ...rest
}) {
  const stdoutBuffer = Buffer.concat(stdout);
  const stderrBuffer = Buffer.concat(stderr);
  return {
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    durationMs: Math.round(performance.now() - started),
    startedAt,
    completedAt: new Date().toISOString(),
    stdout: stdoutBuffer,
    stderr: stderrBuffer,
    stdoutDigest: sha256Buffer(stdoutBuffer),
    stderrDigest: sha256Buffer(stderrBuffer),
    ...rest,
  };
}

export async function runCapturedCommand(
  command,
  args,
  cwd,
  env = process.env,
) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    // npm-style Windows shims are executable directly. Do not route frozen
    // argv through caller-controlled ComSpec/cmd.exe meta parsing.
    const executable =
      process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(Buffer.from(String(error.message)));
      resolve(
        capturedResult({
          started,
          startedAt,
          stdout,
          stderr,
          exitCode: null,
          status: "failed",
          error: error.message,
        }),
      );
    });
    child.on("exit", (exitCode, signal) => {
      resolve(
        capturedResult({
          started,
          startedAt,
          stdout,
          stderr,
          exitCode,
          ...(signal ? { signal } : {}),
        }),
      );
    });
  });
}

export async function runShellStringCommand(
  commandString,
  cwd,
  env = process.env,
) {
  const sanitizedCommand = stripCredentialPlaceholders(commandString);
  const started = performance.now();
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(sanitizedCommand, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(Buffer.from(String(error.message)));
      resolve(
        capturedResult({
          started,
          startedAt,
          stdout,
          stderr,
          exitCode: null,
          status: "failed",
          error: error.message,
        }),
      );
    });
    child.on("exit", (exitCode, signal) => {
      resolve(
        capturedResult({
          started,
          startedAt,
          stdout,
          stderr,
          exitCode,
          ...(signal ? { signal } : {}),
        }),
      );
    });
  });
}

function packageScriptExists(packageJson, scriptName) {
  return Boolean(packageJson?.scripts?.[scriptName]);
}

function resolvePnpmRunnerCommand(runner) {
  if (typeof runner !== "string") return null;
  const match = runner.match(/^pnpm\s+(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  const script = match[1];
  const rest = match[2] ? match[2].split(/\s+/).filter(Boolean) : [];
  return { script, command: ["pnpm", script, ...rest] };
}

export async function resolveHeavyCommand({
  entry,
  qualityIndex,
  packageJson,
}) {
  if (entry.qualityManifestId) {
    const heavy = qualityIndex.heavy.get(entry.qualityManifestId);
    if (heavy?.command) {
      return {
        kind: "shell-string",
        commandString: heavy.command,
        available: true,
        manifestEntry: heavy,
      };
    }
    const blocked = qualityIndex.blocked.get(entry.qualityManifestId);
    if (blocked) {
      return {
        kind: "blocked",
        available: false,
        message: blocked.reason,
        requiredAction: blocked.requiredAction,
      };
    }
    return {
      kind: "missing",
      available: false,
      message: `qualityManifestId ${entry.qualityManifestId} not found`,
    };
  }
  if (entry.runner) {
    const resolved = resolvePnpmRunnerCommand(entry.runner);
    if (!resolved) {
      return {
        kind: "missing",
        available: false,
        message: `Unsupported runner form: ${entry.runner}`,
      };
    }
    if (!packageScriptExists(packageJson, resolved.script)) {
      return {
        kind: "missing",
        available: false,
        message: `Runner script not registered in package.json: ${resolved.script}`,
      };
    }
    return { kind: "argv", command: resolved.command, available: true };
  }
  return {
    kind: "missing",
    available: false,
    message: "No qualityManifestId or runner configured",
  };
}

export function validateHeavyReportBinding(report, candidate, expected) {
  const commitSha = expected?.commitSha ?? candidate?.commitSha;
  const treeSha = expected?.treeSha ?? candidate?.treeSha;
  if (!report.candidateCommitSha || report.candidateCommitSha !== commitSha) {
    return {
      ok: false,
      message: `report candidateCommitSha mismatch (expected ${commitSha})`,
    };
  }
  if (!report.candidateTreeSha || report.candidateTreeSha !== treeSha) {
    return {
      ok: false,
      message: `report candidateTreeSha mismatch (expected ${treeSha})`,
    };
  }
  if (!expected?.suiteId || report.suiteId !== expected.suiteId) {
    return { ok: false, message: "report suiteId mismatch or missing" };
  }
  if (!expected?.runId || report.runId !== expected.runId) {
    return { ok: false, message: "report runId mismatch or missing" };
  }
  if (
    !expected?.commandDigest ||
    report.commandDigest !== expected.commandDigest
  ) {
    return { ok: false, message: "report commandDigest mismatch or missing" };
  }
  if (expected?.freezeId && report.freezeId !== expected.freezeId) {
    return { ok: false, message: "report freezeId mismatch or missing" };
  }
  if (
    expected?.certificationRunId &&
    report.certificationRunId !== expected.certificationRunId
  ) {
    return {
      ok: false,
      message: "report certificationRunId mismatch or missing",
    };
  }
  if (expected?.attempt && report.attempt !== expected.attempt) {
    return {
      ok: false,
      message: `report attempt ${report.attempt} != expected ${expected.attempt}`,
    };
  }
  const completedAt = report.completedAt ?? report.finishedAt;
  if (!report.startedAt || !completedAt) {
    return { ok: false, message: "report startedAt/completedAt required" };
  }
  return { ok: true };
}

export async function readEvaluationReport(artifactDir, suiteId, options = {}) {
  const { outputPath, allowedPaths = [], env = process.env } = options;
  const candidates = [];
  const primary = outputPath ?? env.GATE_B2_OUTPUT_PATH;
  if (primary) candidates.push(primary);
  if (!primary) {
    candidates.push(path.join(artifactDir, "heavy", suiteId, "report.json"));
  }
  for (const allowed of allowedPaths) {
    if (allowed) candidates.push(allowed);
  }
  for (const candidatePath of candidates) {
    if (await pathExists(candidatePath)) {
      return JSON.parse(await readFile(candidatePath, "utf8"));
    }
  }
  return null;
}

export const readHeavyLiveReport = readEvaluationReport;

function validateChronicleTerminalFailure(failure, index) {
  if (!isRecord(failure)) {
    return {
      ok: false,
      message: `Chronicle failed case ${index} terminalFailure must be an object`,
    };
  }
  if (failure.kind === "terminal-pipeline-failure") {
    const completeInvocationTuple =
      typeof failure.stageId === "string" &&
      failure.stageId.length > 0 &&
      Number.isSafeInteger(failure.invocationIndex) &&
      failure.invocationIndex >= 0 &&
      (failure.parseStatus === null ||
        failure.parseStatus === "parsed" ||
        failure.parseStatus === "invalid");
    const absentInvocationTuple =
      failure.stageId === null &&
      failure.invocationIndex === null &&
      failure.parseStatus === null;
    if (
      !Object.hasOwn(failure, "stageId") ||
      !Object.hasOwn(failure, "invocationIndex") ||
      !Object.hasOwn(failure, "parseStatus") ||
      (!completeInvocationTuple && !absentInvocationTuple)
    ) {
      return {
        ok: false,
        message: `Chronicle failed case ${index} terminalFailure invocation tuple is invalid`,
      };
    }
    return { ok: true };
  }
  if (failure.kind === "diagnostic-parity-failure") {
    if (
      !Number.isSafeInteger(failure.dispatchCount) ||
      failure.dispatchCount < 0 ||
      !Number.isSafeInteger(failure.diagnosticCount) ||
      failure.diagnosticCount < 0 ||
      !Array.isArray(failure.dispatchKeys) ||
      !Array.isArray(failure.diagnosticKeys) ||
      failure.dispatchCount !== failure.dispatchKeys.length ||
      failure.diagnosticCount !== failure.diagnosticKeys.length ||
      !failure.dispatchKeys.every(
        (key) => typeof key === "string" && key.length > 0,
      ) ||
      !failure.diagnosticKeys.every(
        (key) => typeof key === "string" && key.length > 0,
      )
    ) {
      return {
        ok: false,
        message: `Chronicle failed case ${index} diagnostic parity failure shape is invalid`,
      };
    }
    const keysMatch =
      failure.dispatchKeys.length === failure.diagnosticKeys.length &&
      failure.dispatchKeys.every(
        (key, keyIndex) => key === failure.diagnosticKeys[keyIndex],
      );
    if (keysMatch) {
      return {
        ok: false,
        message: `Chronicle failed case ${index} diagnostic parity failure does not describe a mismatch`,
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    message: `Chronicle failed case ${index} terminalFailure.kind is invalid`,
  };
}

function hasExactOwnKeys(record, expectedKeys) {
  const actualKeys = Object.keys(record).sort();
  const canonicalKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === canonicalKeys.length &&
    actualKeys.every((key, index) => key === canonicalKeys[index])
  );
}

function validateChronicleCaseProtocolBinding(entry, index, collection) {
  const binding = validateCurrentNarrativeEvalProtocolBinding(entry);
  if (!binding.ok) {
    return {
      ok: false,
      message: `Chronicle ${collection} case ${index} ${binding.message}`,
    };
  }
  return { ok: true };
}

function validateChronicleScoredEvaluation(entry, index) {
  const evaluation = entry.evaluation;
  if (!isRecord(evaluation)) {
    return {
      ok: false,
      message: `Chronicle case ${index} is missing its evaluation result`,
    };
  }
  if (typeof evaluation.passed !== "boolean") {
    return {
      ok: false,
      message: `Chronicle case ${index} evaluation.passed must be boolean`,
    };
  }
  for (const key of ["parseFailureCount", "unresolvedEvidenceCount"]) {
    if (!Number.isSafeInteger(evaluation[key]) || evaluation[key] < 0) {
      return {
        ok: false,
        message: `Chronicle case ${index} evaluation.${key} must be a non-negative integer`,
      };
    }
  }
  for (const key of ["criticalViolations", "unobservableDimensions"]) {
    if (!Array.isArray(evaluation[key])) {
      return {
        ok: false,
        message: `Chronicle case ${index} evaluation.${key} must be an array`,
      };
    }
  }
  if (!isRecord(evaluation.dimensions)) {
    return {
      ok: false,
      message: `Chronicle case ${index} evaluation.dimensions must be an object`,
    };
  }
  if (
    !hasExactOwnKeys(
      evaluation.dimensions,
      CHRONICLE_PRODUCTION_EXPECTED_DIMENSION_KEYS,
    )
  ) {
    return {
      ok: false,
      message: `Chronicle case ${index} evaluation.dimensions keys are invalid`,
    };
  }
  for (const dimension of CHRONICLE_PRODUCTION_EXPECTED_DIMENSION_KEYS) {
    const score = evaluation.dimensions[dimension];
    if (!isRecord(score)) {
      return {
        ok: false,
        message: `Chronicle case ${index} evaluation.dimensions.${dimension} must be an object`,
      };
    }
    if (!hasExactOwnKeys(score, CHRONICLE_PRODUCTION_DIMENSION_SCORE_KEYS)) {
      return {
        ok: false,
        message: `Chronicle case ${index} evaluation.dimensions.${dimension} keys are invalid`,
      };
    }
    for (const key of CHRONICLE_PRODUCTION_DIMENSION_SCORE_KEYS) {
      if (!Number.isSafeInteger(score[key]) || score[key] < 0) {
        return {
          ok: false,
          message: `Chronicle case ${index} evaluation.dimensions.${dimension}.${key} must be a non-negative integer`,
        };
      }
    }
  }
  const semanticPassed =
    evaluation.criticalViolations.length === 0 &&
    CHRONICLE_PRODUCTION_EXPECTED_DIMENSION_KEYS.every(
      (dimension) =>
        evaluation.dimensions[dimension].falsePositive === 0 &&
        evaluation.dimensions[dimension].falseNegative === 0,
    );
  if (evaluation.passed !== semanticPassed) {
    return {
      ok: false,
      message: `Chronicle case ${index} evaluation.passed disagrees with semantic dimension scores`,
    };
  }
  const isCertificationClean =
    evaluation.parseFailureCount === 0 &&
    evaluation.unresolvedEvidenceCount === 0 &&
    evaluation.criticalViolations.length === 0 &&
    evaluation.unobservableDimensions.length === 0 &&
    CHRONICLE_PRODUCTION_EXPECTED_DIMENSION_KEYS.every(
      (dimension) => evaluation.dimensions[dimension].unobservable === 0,
    );
  return {
    ok: true,
    isCertificationClean,
    isSemanticFailure: !evaluation.passed && isCertificationClean,
  };
}

/**
 * Validate the Chronicle report accounting contract needed by
 * qualification/certification. Case identity is bound to the canonical
 * production corpus; terminal cases must preserve the runner's structured
 * failure shape so counts cannot hide an unobserved or malformed case.
 */
export function validateChronicleProductionCaseAccounting(
  report,
  expectedCaseCount = CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.length,
) {
  if (expectedCaseCount !== CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.length) {
    return {
      ok: false,
      message: `Chronicle expected caseCount is fixed at ${CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.length}`,
    };
  }
  const expectedCaseIds = CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS;
  const expectedIds = new Set(expectedCaseIds);
  if (!Array.isArray(report?.cases)) {
    return { ok: false, message: "Chronicle report cases must be an array" };
  }
  if (!Array.isArray(report?.failedCases)) {
    return {
      ok: false,
      message: "Chronicle report failedCases must be an array",
    };
  }
  const canonicalCaseCount = expectedCaseIds.length;
  if (report.caseCount !== canonicalCaseCount) {
    return {
      ok: false,
      message: `expected caseCount ${canonicalCaseCount}, got ${report.caseCount}`,
    };
  }
  const accountedCaseCount = report.cases.length + report.failedCases.length;
  if (accountedCaseCount !== report.caseCount) {
    return {
      ok: false,
      message: `Chronicle case accounting mismatch: cases ${report.cases.length} + failedCases ${report.failedCases.length} != caseCount ${report.caseCount}`,
    };
  }
  const seenCaseIds = new Set();
  const validateCaseIdentity = (entry, index, collection) => {
    if (!isRecord(entry) || typeof entry.caseId !== "string") {
      return {
        ok: false,
        message: `Chronicle ${collection} case ${index} must include a caseId`,
      };
    }
    if (entry.caseId.length === 0) {
      return {
        ok: false,
        message: `Chronicle ${collection} case ${index} caseId must be non-empty`,
      };
    }
    if (!expectedIds.has(entry.caseId)) {
      return {
        ok: false,
        message: `Chronicle ${collection} case ${index} has unknown caseId ${entry.caseId}`,
      };
    }
    if (seenCaseIds.has(entry.caseId)) {
      return {
        ok: false,
        message: `Chronicle case accounting contains duplicate caseId ${entry.caseId}`,
      };
    }
    seenCaseIds.add(entry.caseId);
    return { ok: true };
  };
  const scoredCounts = { passed: 0, failed: 0 };
  let scoredTechnicalFailureCount = 0;
  let scoredSemanticFailureCount = 0;
  for (const [index, entry] of report.cases.entries()) {
    const identity = validateCaseIdentity(entry, index, "scored");
    if (!identity.ok) return identity;
    const protocol = validateChronicleCaseProtocolBinding(
      entry,
      index,
      "scored",
    );
    if (!protocol.ok) return protocol;
    if (Object.hasOwn(entry, "terminalFailure")) {
      return {
        ok: false,
        message: `Chronicle scored case ${index} must not include terminalFailure`,
      };
    }
    const evaluation = validateChronicleScoredEvaluation(entry, index);
    if (!evaluation.ok) return evaluation;
    scoredCounts[entry.evaluation.passed ? "passed" : "failed"] += 1;
    if (!evaluation.isCertificationClean) scoredTechnicalFailureCount += 1;
    else if (evaluation.isSemanticFailure) scoredSemanticFailureCount += 1;
  }
  for (const [index, entry] of report.failedCases.entries()) {
    const identity = validateCaseIdentity(entry, index, "failed");
    if (!identity.ok) return identity;
    const protocol = validateChronicleCaseProtocolBinding(
      entry,
      index,
      "failed",
    );
    if (!protocol.ok) return protocol;
    const terminalFailure = validateChronicleTerminalFailure(
      entry.terminalFailure,
      index,
    );
    if (!terminalFailure.ok) return terminalFailure;
  }
  if (seenCaseIds.size !== expectedCaseIds.length) {
    const missingCaseIds = expectedCaseIds.filter(
      (caseId) => !seenCaseIds.has(caseId),
    );
    return {
      ok: false,
      message: `Chronicle case accounting is missing expected caseId(s): ${missingCaseIds.join(", ")}`,
    };
  }
  if (!isRecord(report.summary)) {
    return { ok: false, message: "Chronicle report summary is missing" };
  }
  for (const key of ["passed", "failed", "parseFailureCount"]) {
    if (!Number.isSafeInteger(report.summary[key]) || report.summary[key] < 0) {
      return {
        ok: false,
        message: `Chronicle summary.${key} must be a non-negative integer`,
      };
    }
  }
  if (report.summary.passed !== scoredCounts.passed) {
    return {
      ok: false,
      message: `Chronicle summary.passed ${report.summary.passed} != scored cases ${scoredCounts.passed}`,
    };
  }
  if (
    report.summary.failed !==
    scoredCounts.failed + report.failedCases.length
  ) {
    return {
      ok: false,
      message: `Chronicle summary.failed ${report.summary.failed} != scored failures ${scoredCounts.failed} + failedCases ${report.failedCases.length}`,
    };
  }
  if (report.summary.passed + report.summary.failed !== report.caseCount) {
    return {
      ok: false,
      message: `Chronicle summary counts do not account for ${report.caseCount} cases`,
    };
  }
  if (scoredTechnicalFailureCount > 0) {
    return {
      ok: false,
      message: `Chronicle scored cases contain ${scoredTechnicalFailureCount} certification-disqualifying evaluation(s)`,
    };
  }
  return {
    ok: true,
    scoredCaseCount: report.cases.length,
    passedCaseCount: scoredCounts.passed,
    failedCaseCount: scoredCounts.failed,
    terminalFailureCount: report.failedCases.length,
    scoredSemanticFailureCount,
  };
}

/**
 * The certification flag is a claim made by the live runner, not an
 * authority by itself. Certification requires every expected case to reach
 * scoring, every scored case to pass, and no parser or terminal failure to
 * be present.
 */
export function validateChronicleProductionCertificationAccounting(
  report,
  accounting,
) {
  if (
    accounting?.scoredCaseCount !==
      CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.length ||
    accounting.passedCaseCount !==
      CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.length ||
    accounting.failedCaseCount !== 0 ||
    accounting.terminalFailureCount !== 0 ||
    report?.summary?.parseFailureCount !== 0
  ) {
    return {
      ok: false,
      message: `Chronicle certification requires ${CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.length} scored/passed cases with no terminal or parse failures`,
    };
  }
  return { ok: true, message: "chronicle certification accounting accepted" };
}

export function validateChronicleProductionReport(report, candidate, expected) {
  if (!report) {
    return {
      ok: false,
      message: "chronicle production report missing under heavy artifacts",
    };
  }
  const binding = validateHeavyReportBinding(report, candidate, expected);
  if (!binding.ok) return binding;
  const protocol = validateCurrentNarrativeEvalProtocolBinding(report);
  if (!protocol.ok) return protocol;
  if (report.mode !== "chronicle-production-live") {
    return {
      ok: false,
      message: "chronicle production report mode is invalid",
    };
  }
  if (report.diagnosticOnly === true || report.attempt === 2) {
    return {
      ok: false,
      message: "diagnostic-only / attempt 2 cannot pass certification Heavy",
    };
  }
  if (report.attempt !== 1) {
    return { ok: false, message: `expected attempt 1, got ${report.attempt}` };
  }
  const accounting = validateChronicleProductionCaseAccounting(report);
  if (!accounting.ok) return accounting;
  if (report.certificationEligible !== true) {
    return { ok: false, message: "certificationEligible must be true" };
  }
  const certificationAccounting =
    validateChronicleProductionCertificationAccounting(report, accounting);
  if (!certificationAccounting.ok) return certificationAccounting;
  return { ok: true, message: "chronicle production report accepted" };
}

export function validateWebAiConsentReport(report, expected) {
  if (!report) return { ok: false, message: "web AI consent report missing" };
  const binding = validateHeavyReportBinding(
    report,
    { commitSha: expected?.commitSha, treeSha: expected?.treeSha },
    expected,
  );
  if (!binding.ok) return binding;
  if (report.certificationEligible !== true) {
    return { ok: false, message: "consent certificationEligible must be true" };
  }
  const teardown = report.teardown ?? {};
  if (teardown.serverClosed !== true || teardown.localStorageCleared !== true) {
    return {
      ok: false,
      message: "consent teardown flags must be observed true after teardown",
    };
  }
  return { ok: true, message: "consent report accepted" };
}

export function validateWebAiConsentBrowserReport(report, expected) {
  if (!report) {
    return { ok: false, message: "web AI browser consent report missing" };
  }
  const binding = validateHeavyReportBinding(
    report,
    { commitSha: expected?.commitSha, treeSha: expected?.treeSha },
    expected,
  );
  if (!binding.ok) return binding;
  if (report.mode !== "web-ai-consent-browser-live") {
    return { ok: false, message: "browser consent report mode is invalid" };
  }
  if (report.certificationEligible !== true) {
    return {
      ok: false,
      message: "browser consent certificationEligible must be true",
    };
  }
  const browser = report.browser ?? {};
  if (
    browser.realBrowser !== true ||
    browser.provider !== "@vitest/browser-playwright" ||
    browser.engine !== "chromium"
  ) {
    return {
      ok: false,
      message: "browser consent report must prove real Chromium execution",
    };
  }
  const counts = [
    report.requestCountBeforeConsent,
    report.requestCountAfterRefuse,
    report.requestCountAfterApprove,
    report.requestCountAfterDestinationChangeRefuse,
    report.providerRequestCount,
  ];
  if (!counts.every((value) => Number.isInteger(value) && value >= 0)) {
    return {
      ok: false,
      message: "browser consent request counts must be non-negative integers",
    };
  }
  if (
    report.requestCountBeforeConsent !== 0 ||
    report.requestCountAfterRefuse !== 0 ||
    report.requestCountAfterApprove <= 0 ||
    report.requestCountAfterDestinationChangeRefuse !==
      report.requestCountAfterApprove ||
    report.providerRequestCount !==
      report.requestCountAfterDestinationChangeRefuse
  ) {
    return {
      ok: false,
      message:
        "browser consent report does not prove refusal=0, approval>0, and destination re-consent",
    };
  }
  const requiredAssertions = [
    "refusal-before-provider-is-zero-http",
    "approval-dispatches-provider-http",
    "destination-change-requires-fresh-consent",
    "indexeddb-and-localstorage-are-cleared",
    "browser-mock-is-closed-before-evidence",
  ];
  if (
    !Array.isArray(report.assertions) ||
    !requiredAssertions.every((assertion) =>
      report.assertions.includes(assertion),
    )
  ) {
    return {
      ok: false,
      message: "browser consent report is missing required journey assertions",
    };
  }
  const teardown = report.teardown ?? {};
  if (
    teardown.serverClosed !== true ||
    teardown.evidenceServerClosed !== true ||
    teardown.localStorageCleared !== true ||
    teardown.indexedDbCleared !== true ||
    teardown.consentBrokerDeclined !== true ||
    teardown.browserMockClosed !== true
  ) {
    return {
      ok: false,
      message:
        "browser consent teardown must close servers, storage, broker, and mock",
    };
  }
  return { ok: true, message: "browser consent report accepted" };
}
