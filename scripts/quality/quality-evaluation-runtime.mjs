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
import path from "node:path";
import { performance } from "node:perf_hooks";

const PLACEHOLDER_ENV_ASSIGN = /\b([A-Z][A-Z0-9_]*)=\.\.\.(\s+)/g;
export const AI_PROVIDER_CREDENTIAL_ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "OPEN_ROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_ACCESS_TOKEN",
];
const CERTIFICATION_ENV_REMOVALS = [
  "NARRATIVE_EVAL_LIMIT",
  "NARRATIVE_EVAL_CASE_ID",
  "NARRATIVE_EVAL_ATTEMPT",
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

export function validateChronicleProductionReport(report, candidate, expected) {
  if (!report) {
    return {
      ok: false,
      message: "chronicle production report missing under heavy artifacts",
    };
  }
  const binding = validateHeavyReportBinding(report, candidate, expected);
  if (!binding.ok) return binding;
  if (report.diagnosticOnly === true || report.attempt === 2) {
    return {
      ok: false,
      message: "diagnostic-only / attempt 2 cannot pass certification Heavy",
    };
  }
  if (report.attempt !== 1) {
    return { ok: false, message: `expected attempt 1, got ${report.attempt}` };
  }
  if (report.caseCount !== 14) {
    return {
      ok: false,
      message: `expected caseCount 14, got ${report.caseCount}`,
    };
  }
  if (report.certificationEligible !== true) {
    return { ok: false, message: "certificationEligible must be true" };
  }
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
