#!/usr/bin/env node
/**
 * Gate B2 Engineering Certification runner.
 *
 * 正本は report file。stdout は人間向け要約のみ。
 * - 必須 suite を減らさない
 * - credential 不足を passed / skipped へ変換しない
 * - 最初の失敗を保持する
 * - 再試行履歴を残す（Attempt 2 は diagnostic only）
 * - artifact digest を生成する
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import yaml from "js-yaml";
import {
  GATE_B2_ATTEMPT_LEDGER_ROOT,
  getGateB2AttemptLedgerIdentity,
} from "./gate-b2-controller-config.mjs";

import {
  FREEZE_RELATIVE,
  GATE_B2_CONTRACT_VERSION,
  HARNESS_DIGEST_PATHS,
  assertDigestsMatchFreeze,
  assertFreezeActive,
  assertWorkingTreeClean,
  allocateGateB2Attempt,
  bindExecutionRoot,
  buildDecisionDocument,
  buildHeavyCertificationEnv,
  buildJourneyCertificationEnv,
  loadFreezeDocument,
  loadGateB2AttemptLedgerSnapshot,
  persistHeavyReport,
  prepareWorktreeDependencies,
  readHeavyLiveReport,
  sanitizeCertificationEnv,
  stripCredentialPlaceholders,
  writeGateB2AttemptRecord,
  validateChronicleProductionReport,
  validateFullCiEvidence,
  validateJsonAgainstSchema,
  validateJourneyEvidence,
  validateWebAiConsentBrowserReport,
  validateWebAiConsentReport,
  verifyFullCiWithGithub,
} from "./certify-gate-b2-bindings.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MANIFEST_RELATIVE = "evals/certifications/gate-b2.yaml";
const QUALITY_MANIFEST_RELATIVE = "evals/quality-manifest.yaml";
const REPORT_SCHEMA_RELATIVE =
  "evals/certifications/schemas/gate-b2-report-v1.schema.json";
const DECISION_SCHEMA_RELATIVE =
  "evals/certifications/schemas/gate-b2-decision-v1.schema.json";
const JOURNEY_SCHEMA_RELATIVE =
  "evals/certifications/schemas/gate-b2-journey-evidence-v2.schema.json";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const ATTEMPT_LEDGER_ENV = "GATE_B2_ATTEMPT_LEDGER_ROOT";
const DURABLE_ATTEMPT_LEDGER_MESSAGE =
  "durable Gate B2 attempt ledger is required for execution; the fixed controller ledger must be provisioned before certification";

export function resolveAttemptLedgerRoot({
  configuredRoot = null,
  env = process.env,
} = {}) {
  const raw = configuredRoot ?? env[ATTEMPT_LEDGER_ENV] ?? null;
  if (raw != null && String(raw).trim() !== "") {
    throw new Error(
      "Gate B2 attempt ledger is controller-bound; --attempt-ledger-root and GATE_B2_ATTEMPT_LEDGER_ROOT are rejected",
    );
  }
  return path.resolve(GATE_B2_ATTEMPT_LEDGER_ROOT);
}

export function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function sha256Buffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function emptyBucketSummary() {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    hold: 0,
    notRun: 0,
    deferred: 0,
  };
}

export function tallyBucket(suites, bucket) {
  const summary = emptyBucketSummary();
  const requiredBucket = [
    "requiredLight",
    "requiredHeavy",
    "requiredJourneys",
  ].includes(bucket);
  for (const suite of suites.filter((entry) => entry.bucket === bucket)) {
    summary.total += 1;
    switch (suite.result) {
      case "passed":
        summary.passed += 1;
        break;
      case "informational":
        if (requiredBucket) summary.notRun += 1;
        else summary.passed += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "blocked":
        summary.blocked += 1;
        break;
      case "hold":
        summary.hold += 1;
        break;
      case "deferred":
        summary.deferred += 1;
        break;
      default:
        summary.notRun += 1;
    }
  }
  return summary;
}

export function parseCertifyArgs(argv) {
  const result = {
    preflight: false,
    runLight: false,
    runHeavy: false,
    runJourneys: false,
    runInformational: false,
    runReleaseAdjacent: false,
    candidate: null,
    baseMaster: null,
    report: null,
    artifactDir: null,
    attemptLedgerRoot: null,
    format: "markdown",
    ciEvidence: null,
    journeyEvidenceDir: null,
    dryRun: false,
  };
  const readValue = (option, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--preflight") result.preflight = true;
    else if (arg === "--run-light") result.runLight = true;
    else if (arg === "--run-heavy") result.runHeavy = true;
    else if (arg === "--run-journeys") result.runJourneys = true;
    else if (arg === "--run-informational") result.runInformational = true;
    else if (arg === "--run-release-adjacent") result.runReleaseAdjacent = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--candidate") result.candidate = readValue(arg, index++);
    else if (arg === "--base-master")
      result.baseMaster = readValue(arg, index++);
    else if (arg === "--report") result.report = readValue(arg, index++);
    else if (arg === "--artifact-dir")
      result.artifactDir = readValue(arg, index++);
    else if (arg === "--attempt-ledger-root") {
      readValue(arg, index);
      throw new Error(
        "--attempt-ledger-root is rejected; Gate B2 certification uses the fixed controller ledger",
      );
    }
    else if (arg === "--format") result.format = readValue(arg, index++);
    else if (arg === "--ci-evidence")
      result.ciEvidence = readValue(arg, index++);
    else if (arg === "--journey-evidence-dir")
      result.journeyEvidenceDir = readValue(arg, index++);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["markdown", "json"].includes(result.format)) {
    throw new Error(`Unsupported format: ${result.format}`);
  }
  const executionFlags = [
    result.runLight,
    result.runHeavy,
    result.runJourneys,
    result.runInformational,
    result.runReleaseAdjacent,
  ];
  if (result.preflight && executionFlags.some(Boolean)) {
    throw new Error("--preflight cannot be combined with execution flags");
  }
  if (
    !result.preflight &&
    !result.runLight &&
    !result.runHeavy &&
    !result.runJourneys &&
    !result.runInformational &&
    !result.runReleaseAdjacent
  ) {
    result.preflight = true;
  }
  return result;
}

export function certificationExitCode(report) {
  if (report.verdict === "PASS") return 0;
  if (report.verdict === "INCOMPLETE" && report.mode === "preflight") return 0;
  return 1;
}

export function validateGateB2Manifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return ["manifest must be an object"];
  }
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (raw.contractVersion !== GATE_B2_CONTRACT_VERSION) {
    errors.push(`contractVersion must be ${GATE_B2_CONTRACT_VERSION}`);
  }
  if (raw.id !== "gate-b2") errors.push("id must be gate-b2");
  if (!raw.candidate || typeof raw.candidate !== "object") {
    errors.push("candidate contract must be an object");
  } else if (
    !Number.isSafeInteger(raw.candidate.schemaVersion) ||
    raw.candidate.schemaVersion < 1
  ) {
    errors.push("candidate.schemaVersion must be a positive integer");
  }
  const ledger = getGateB2AttemptLedgerIdentity();
  if (raw.candidate?.attemptLedgerId !== ledger.attemptLedgerId) {
    errors.push("candidate.attemptLedgerId must match the fixed controller ledger");
  }
  if (
    raw.candidate?.attemptLedgerAttestation !==
    ledger.attemptLedgerAttestation
  ) {
    errors.push(
      "candidate.attemptLedgerAttestation must match the fixed controller configuration",
    );
  }
  if (
    raw.candidate?.attemptLedgerConfigDigest !==
    ledger.attemptLedgerConfigDigest
  ) {
    errors.push(
      "candidate.attemptLedgerConfigDigest must match the fixed controller configuration",
    );
  }
  for (const key of [
    "requiredLight",
    "requiredHeavy",
    "informational",
    "releaseAdjacent",
    "requiredManualJourneys",
    "verdicts",
  ]) {
    if (!Array.isArray(raw[key])) errors.push(`${key} must be an array`);
  }
  const lightIds = new Set();
  for (const entry of raw.requiredLight ?? []) {
    if (!entry?.id) errors.push("requiredLight entry missing id");
    else if (lightIds.has(entry.id))
      errors.push(`duplicate requiredLight id: ${entry.id}`);
    else lightIds.add(entry.id);
    if (entry?.certificationCredit === false) {
      errors.push(
        `requiredLight ${entry.id ?? "<missing>"} cannot set certificationCredit:false`,
      );
    }
  }
  const heavyIds = new Set();
  for (const entry of raw.requiredHeavy ?? []) {
    if (!entry?.id) errors.push("requiredHeavy entry missing id");
    else if (heavyIds.has(entry.id))
      errors.push(`duplicate requiredHeavy id: ${entry.id}`);
    else heavyIds.add(entry.id);
    if (entry?.certificationCredit === false) {
      errors.push(
        `requiredHeavy ${entry.id ?? "<missing>"} cannot set certificationCredit:false`,
      );
    }
  }
  if (Array.isArray(raw.verdicts)) {
    for (const verdict of ["PASS", "HOLD", "BLOCK"]) {
      if (!raw.verdicts.includes(verdict)) {
        errors.push(`verdicts must include ${verdict}`);
      }
    }
  }
  if (raw.decisionPolicy?.blockedIsPass === true) {
    errors.push("decisionPolicy.blockedIsPass must be false");
  }
  if (raw.decisionPolicy?.deferredIsPass === true) {
    errors.push("decisionPolicy.deferredIsPass must be false");
  }
  if (raw.decisionPolicy?.skippedIsPass === true) {
    errors.push("decisionPolicy.skippedIsPass must be false");
  }
  if (raw.decisionPolicy?.credentialShortageIsPass === true) {
    errors.push("decisionPolicy.credentialShortageIsPass must be false");
  }
  if (raw.decisionPolicy?.retryOverwritePass === true) {
    errors.push("decisionPolicy.retryOverwritePass must be false");
  }
  for (const entry of raw.requiredManualJourneys ?? []) {
    if (!entry?.id) {
      errors.push("requiredManualJourneys entry missing id");
      continue;
    }
    if (!entry.runnerId) {
      errors.push(`requiredManualJourneys ${entry.id} missing runnerId`);
    }
    if (!entry.runnerVersion) {
      errors.push(`requiredManualJourneys ${entry.id} missing runnerVersion`);
    }
    if (
      !Array.isArray(entry.requiredAssertions) ||
      entry.requiredAssertions.length === 0
    ) {
      errors.push(
        `requiredManualJourneys ${entry.id} requiredAssertions must be a non-empty array`,
      );
    }
    if (
      entry.status !== "blocked" &&
      (!Array.isArray(entry.command) ||
        entry.command.length < 2 ||
        entry.command.some(
          (part) => typeof part !== "string" || part.length === 0,
        ))
    ) {
      errors.push(
        `requiredManualJourneys ${entry.id} active entry requires a non-empty argv command`,
      );
    }
    if (entry.status === "blocked" && !entry.requiredAction) {
      errors.push(
        `requiredManualJourneys ${entry.id} blocked status requires requiredAction`,
      );
    }
    if (entry.certificationCredit === false) {
      errors.push(
        `requiredManualJourneys ${entry.id} cannot set certificationCredit:false`,
      );
    }
    if (entry.status !== "blocked") {
      if (
        !Array.isArray(entry.runner?.command) ||
        entry.runner.command.length === 0
      ) {
        errors.push(
          `requiredManualJourneys ${entry.id} active journey requires runner.command`,
        );
      }
      if (
        typeof entry.runner?.sourcePath !== "string" ||
        !Object.values(HARNESS_DIGEST_PATHS).includes(entry.runner.sourcePath)
      ) {
        errors.push(
          `requiredManualJourneys ${entry.id} runner.sourcePath must be frozen in HARNESS_DIGEST_PATHS`,
        );
      } else if (!entry.runner.command.includes(entry.runner.sourcePath)) {
        errors.push(
          `requiredManualJourneys ${entry.id} runner.command must execute runner.sourcePath directly`,
        );
      }
    }
  }
  const fullCi = raw.fullCi;
  if (!fullCi || typeof fullCi !== "object") {
    errors.push("fullCi contract must be an object");
  } else {
    if (!Number.isFinite(Number(fullCi.workflowId))) {
      errors.push("fullCi.workflowId must be a number");
    }
    if (
      typeof fullCi.workflowPath !== "string" ||
      !fullCi.workflowPath.endsWith(".yml")
    ) {
      errors.push("fullCi.workflowPath must be a .yml path");
    }
    if (
      !Array.isArray(fullCi.acceptedEvents) ||
      fullCi.acceptedEvents.length === 0
    ) {
      errors.push("fullCi.acceptedEvents must be a non-empty array");
    } else if (fullCi.acceptedEvents.includes("pull_request")) {
      errors.push(
        "fullCi.acceptedEvents must not include pull_request (merge commits are not candidate trees)",
      );
    }
    if (
      !Array.isArray(fullCi.requiredJobs) ||
      fullCi.requiredJobs.length === 0
    ) {
      errors.push("fullCi.requiredJobs must be a non-empty array");
    }
  }
  return errors;
}

export function parseQualityHeavyIndex(qualityManifest) {
  const heavy = new Map();
  const blocked = new Map();
  for (const entry of qualityManifest?.heavyEvaluations ?? []) {
    heavy.set(entry.id, entry);
  }
  for (const entry of qualityManifest?.blockedEvaluations ?? []) {
    blocked.set(entry.id, entry);
  }
  return { heavy, blocked };
}

async function readText(repoRoot, relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function fileDigest(repoRoot, relativePath) {
  const buffer = await readFile(path.join(repoRoot, relativePath));
  return sha256Buffer(buffer);
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

export async function resolveCandidateIdentity({
  candidate,
  baseMaster,
  repoRoot = DEFAULT_REPO_ROOT,
} = {}) {
  const commitSha = (
    candidate
      ? await runGit(["rev-parse", candidate], repoRoot)
      : await runGit(["rev-parse", "HEAD"], repoRoot)
  ).toLowerCase();
  if (!COMMIT_RE.test(commitSha)) {
    throw new Error(`Invalid commit SHA: ${commitSha}`);
  }
  const treeSha = (
    await runGit(["rev-parse", `${commitSha}^{tree}`], repoRoot)
  ).toLowerCase();
  let baseMasterSha = null;
  if (baseMaster) {
    baseMasterSha = (
      await runGit(["rev-parse", baseMaster], repoRoot)
    ).toLowerCase();
  } else {
    try {
      baseMasterSha = (
        await runGit(["rev-parse", "origin/master"], repoRoot)
      ).toLowerCase();
    } catch {
      try {
        baseMasterSha = (
          await runGit(["rev-parse", "master"], repoRoot)
        ).toLowerCase();
      } catch {
        baseMasterSha = null;
      }
    }
  }
  const dirty = Boolean(
    await runGit(["status", "--porcelain"], repoRoot).then((out) => out.length),
  );
  return { commitSha, treeSha, baseMasterSha, dirty };
}

export async function collectInputDigests(
  manifest,
  repoRoot = DEFAULT_REPO_ROOT,
  { manifestDigest = null } = {},
) {
  const inputs = manifest.inputs ?? {};
  const digests = {
    writerRegistryDigest: await fileDigest(repoRoot, inputs.writerRegistry),
    aiPathRegistryDigest: await fileDigest(repoRoot, inputs.aiPathRegistry),
    qualityManifestDigest: await fileDigest(repoRoot, inputs.qualityManifest),
    narrativeEvalManifestDigest: await fileDigest(
      repoRoot,
      inputs.narrativeEvalManifest,
    ),
    adrChecklistDigest: await fileDigest(repoRoot, inputs.adrChecklist),
    classificationDigest: await fileDigest(repoRoot, inputs.classification),
  };
  for (const [key, relativePath] of Object.entries(HARNESS_DIGEST_PATHS)) {
    digests[key] = await fileDigest(repoRoot, relativePath);
  }
  if (manifestDigest) {
    digests.certificationManifestDigest = manifestDigest;
  }
  return digests;
}

function environmentInfo() {
  const node = process.version;
  const platform = process.platform;
  const arch = process.arch;
  return {
    node,
    platform,
    arch,
    digest: sha256Text(JSON.stringify({ node, platform, arch })),
  };
}

function notRunSuite({ suiteId, bucket, message, command = null }) {
  return {
    suiteId,
    bucket,
    attempt: 1,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    environmentDigest: null,
    commandDigest: command ? sha256Text(JSON.stringify(command)) : null,
    stdoutDigest: null,
    stderrDigest: null,
    artifactDigests: [],
    result: "not-run",
    message,
    ...(command ? { command } : {}),
  };
}

function blockedSuite({
  suiteId,
  bucket,
  message,
  command = null,
  environmentDigest = null,
}) {
  return {
    suiteId,
    bucket,
    attempt: 1,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: null,
    environmentDigest,
    commandDigest: command ? sha256Text(JSON.stringify(command)) : null,
    stdoutDigest: null,
    stderrDigest: null,
    artifactDigests: [],
    result: "blocked",
    message,
    ...(command ? { command } : {}),
  };
}

function suiteFromCapture({
  suiteId,
  bucket,
  command,
  environment,
  captured,
  message,
}) {
  return {
    suiteId,
    bucket,
    attempt: 1,
    startedAt: captured.startedAt ?? null,
    completedAt: captured.completedAt ?? new Date().toISOString(),
    exitCode: captured.exitCode ?? null,
    environmentDigest: environment.digest,
    commandDigest: sha256Text(JSON.stringify(command)),
    stdoutDigest: captured.stdoutDigest ?? null,
    stderrDigest: captured.stderrDigest ?? null,
    artifactDigests: [],
    result: "failed",
    message,
    command,
  };
}

async function recordCertificationSuiteAttempt({
  allocation,
  candidate,
  result,
}) {
  if (!allocation) return result;
  const normalized = { ...result, attempt: allocation.attempt };
  const ledger = allocation.ledgerIdentity;
  if (!ledger || !Number.isInteger(allocation.sequence)) {
    throw new Error("Gate B2 attempt allocation is missing controller ledger state");
  }
  await writeGateB2AttemptRecord({
    attemptDir: allocation.attemptDir,
    record: {
      schemaVersion: 1,
      contractVersion: GATE_B2_CONTRACT_VERSION,
      attemptLedgerId: ledger.attemptLedgerId,
      attemptLedgerConfigDigest: ledger.attemptLedgerConfigDigest,
      attemptLedgerInstanceId: ledger.attemptLedgerInstanceId,
      controllerReceiptDigest: ledger.controllerReceiptDigest,
      attemptLedgerAttestation: ledger.attemptLedgerAttestation,
      candidateCommitSha: candidate.commitSha,
      candidateTreeSha: candidate.treeSha,
      suiteId: normalized.suiteId,
      bucket: normalized.bucket,
      attempt: normalized.attempt,
      sequence: allocation.sequence,
      previousRecordDigest: allocation.previousRecordDigest,
      startedAt: normalized.startedAt,
      completedAt: normalized.completedAt,
      exitCode: normalized.exitCode,
      environmentDigest: normalized.environmentDigest,
      commandDigest: normalized.commandDigest,
      stdoutDigest: normalized.stdoutDigest,
      stderrDigest: normalized.stderrDigest,
      artifactDigests: normalized.artifactDigests,
      result: normalized.result,
      message: normalized.message,
    },
  });
  return normalized;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
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

export async function runCapturedCommand(
  command,
  args,
  cwd,
  env = process.env,
) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    // npm-style Windows shims are executable directly. Do not route the
    // frozen argv through caller-controlled ComSpec/cmd.exe meta parsing.
    const executable =
      process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const commandArgs = args;
    const child = spawn(executable, commandArgs, {
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
      const stdoutBuf = Buffer.concat(stdout);
      const stderrBuf = Buffer.concat([
        ...stderr,
        Buffer.from(String(error.message)),
      ]);
      resolve({
        status: "failed",
        exitCode: null,
        error: error.message,
        durationMs: Math.round(performance.now() - started),
        startedAt,
        completedAt: new Date().toISOString(),
        stdout: stdoutBuf,
        stderr: stderrBuf,
        stdoutDigest: sha256Buffer(stdoutBuf),
        stderrDigest: sha256Buffer(stderrBuf),
      });
    });
    child.on("exit", (exitCode, signal) => {
      const stdoutBuf = Buffer.concat(stdout);
      const stderrBuf = Buffer.concat(stderr);
      resolve({
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        ...(signal ? { signal } : {}),
        durationMs: Math.round(performance.now() - started),
        startedAt,
        completedAt: new Date().toISOString(),
        stdout: stdoutBuf,
        stderr: stderrBuf,
        stdoutDigest: sha256Buffer(stdoutBuf),
        stderrDigest: sha256Buffer(stderrBuf),
      });
    });
  });
}

async function evaluateFullCiEvidence({
  artifactDir,
  ciEvidence,
  candidate,
  dryRun = false,
  repoRoot = DEFAULT_REPO_ROOT,
  fetchRun,
  fullCiContract = null,
}) {
  const evidencePath =
    ciEvidence ??
    (artifactDir ? path.join(artifactDir, "light/full-ci.json") : null);
  if (!evidencePath || !(await pathExists(evidencePath))) {
    return blockedSuite({
      suiteId: "full-ci",
      bucket: "requiredLight",
      message:
        "full-ci evidence missing. Provide --ci-evidence or light/full-ci.json under the artifact dir.",
    });
  }
  const raw = JSON.parse(await readFile(evidencePath, "utf8"));
  const digest = sha256Text(JSON.stringify(raw));
  let validation = validateFullCiEvidence(raw, candidate, fullCiContract);
  if (validation.ok && !dryRun) {
    validation = await verifyFullCiWithGithub(raw, candidate, {
      fetchRun,
      repoRoot,
      fullCiContract,
    });
  }
  const artifactDigests = [digest];
  if (validation.checkoutArtifactDigest) {
    artifactDigests.push(validation.checkoutArtifactDigest);
  }
  let message = validation.message;
  if (validation.checkoutArtifactId != null) {
    message = `${message}; checkout artifact id=${validation.checkoutArtifactId}`;
  }
  if (validation.checkoutCommitSha) {
    message = `${message}; checkout commit=${validation.checkoutCommitSha}`;
  }
  if (validation.checkoutTreeSha) {
    message = `${message}; checkout tree=${validation.checkoutTreeSha}`;
  }
  return {
    suiteId: "full-ci",
    bucket: "requiredLight",
    attempt: 1,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: validation.ok ? 0 : 1,
    environmentDigest: null,
    commandDigest: null,
    stdoutDigest: null,
    stderrDigest: null,
    artifactDigests,
    result: validation.result,
    message,
  };
}

export async function runJourneySuite({
  journeyEntry,
  candidate,
  environment,
  repoRoot,
  dryRun,
  freeze,
  certificationRunId,
  allocation,
  env,
}) {
  const journeyId = journeyEntry.id;
  const command = journeyEntry.runner?.command ?? journeyEntry.command;
  if (
    journeyEntry.status === "blocked" ||
    String(journeyId).startsWith("blocked-")
  ) {
    return blockedSuite({
      suiteId: journeyId,
      bucket: "requiredJourneys",
      message:
        (journeyEntry.requiredAction
          ? String(journeyEntry.requiredAction).trim()
          : journeyEntry.reason) ||
        `Journey ${journeyId} is blocked until a real runner emits candidate-bound evidence.`,
      command: command ?? null,
    });
  }
  if (!Array.isArray(command) || command.length < 2) {
    return blockedSuite({
      suiteId: journeyId,
      bucket: "requiredJourneys",
      message: `Journey ${journeyId} has no candidate-bound runner command.`,
    });
  }

  if (dryRun) {
    return notRunSuite({
      suiteId: journeyId,
      bucket: "requiredJourneys",
      message:
        "dry-run: candidate-bound Journey runner not executed; external evidence paths are ignored",
      command,
    });
  }
  if (!allocation) {
    return blockedSuite({
      suiteId: journeyId,
      bucket: "requiredJourneys",
      message: "Journey attempt allocation missing; runner was not started.",
      command,
    });
  }

  const commandDigest = sha256Text(JSON.stringify(command));
  const outputPath = path.join(allocation.attemptDir, "journey-evidence.json");
  const runnerArtifactPath = path.join(
    allocation.attemptDir,
    "runner-artifact.json",
  );
  const journeyEnv = buildJourneyCertificationEnv({
    candidate,
    journeyId,
    outputPath,
    runnerArtifactPath,
    commandDigest,
    environmentDigest: environment.digest,
    runnerId: journeyEntry.runnerId,
    runnerVersion: journeyEntry.runnerVersion,
    freezeId: freeze?.freezeId,
    certificationRunId,
    attempt: allocation.attempt,
    attemptDir: allocation.attemptDir,
    ledgerSnapshot: allocation.ledgerSnapshot,
    baseEnv: env,
  });

  const captured = await runCapturedCommand(
    command[0],
    command.slice(1),
    repoRoot,
    journeyEnv,
  );
  const artifactDigests = [];
  let raw = null;
  let evidenceDigest = null;
  let runnerArtifactDigest = null;
  let validation = {
    ok: false,
    result: "failed",
    message: `candidate journey runner did not create fresh evidence: ${outputPath}`,
  };
  if (await pathExists(outputPath)) {
    try {
      const evidenceBuffer = await readFile(outputPath);
      evidenceDigest = sha256Buffer(evidenceBuffer);
      artifactDigests.push(evidenceDigest);
      raw = JSON.parse(evidenceBuffer.toString("utf8"));
    } catch (error) {
      validation = {
        ok: false,
        result: "failed",
        message: `Journey evidence could not be parsed: ${error.message}`,
      };
    }
  }
  if (await pathExists(runnerArtifactPath)) {
    const runnerArtifactBuffer = await readFile(runnerArtifactPath);
    runnerArtifactDigest = sha256Buffer(runnerArtifactBuffer);
    artifactDigests.push(runnerArtifactDigest);
  }
  if (raw) {
    const journeySchema = JSON.parse(
      await readFile(path.join(repoRoot, JOURNEY_SCHEMA_RELATIVE), "utf8"),
    );
    const schemaValidation = validateJsonAgainstSchema(raw, journeySchema);
    validation = schemaValidation.ok
      ? validateJourneyEvidence(raw, {
          journeyId,
          candidate,
          contract: journeyEntry,
          expected: {
            freezeId: freeze?.freezeId,
            certificationRunId,
            commandDigest,
            environmentDigest: environment.digest,
            runnerArtifactDigest,
          },
        })
      : {
          ok: false,
          result: "failed",
          message: `Journey evidence schema validation failed: ${JSON.stringify(schemaValidation.errors)}`,
        };
  }
  let result = "failed";
  if (captured.status === "passed" && validation.ok) {
    result = validation.result;
  }
  const message =
    captured.status !== "passed"
      ? (captured.error ??
        `candidate journey runner exited ${captured.exitCode ?? "without an exit code"}`)
      : validation.message;
  const exitCode =
    captured.status !== "passed"
      ? (captured.exitCode ?? 1)
      : validation.ok
        ? 0
        : 1;
  return {
    suiteId: journeyId,
    bucket: "requiredJourneys",
    attempt: allocation.attempt,
    startedAt: captured.startedAt,
    completedAt: captured.completedAt,
    exitCode,
    environmentDigest: environment.digest,
    commandDigest,
    stdoutDigest: captured.stdoutDigest,
    stderrDigest: captured.stderrDigest,
    artifactDigests,
    result,
    message,
    command,
  };
}

function missingEnv(names) {
  return (names ?? []).filter((name) => !process.env[name]);
}

export function decideVerdict({
  suites,
  candidate,
  decisionPolicy,
  preflightOnly,
  attemptHistory = [],
}) {
  const reasons = [];
  if (preflightOnly) {
    return {
      verdict: "INCOMPLETE",
      reasons: ["preflight-only; no certification verdict"],
    };
  }
  if (decisionPolicy.requireCandidateFreeze && !candidate.frozen) {
    reasons.push("candidate is not frozen (commitSha/treeSha required)");
  }
  if (candidate.dirty) {
    reasons.push("working tree is dirty; freeze requires a clean tree");
  }
  const required = suites.filter((suite) =>
    ["requiredLight", "requiredHeavy", "requiredJourneys"].includes(
      suite.bucket,
    ),
  );
  const invalidRequired = required.filter((suite) => suite.result !== "passed");
  const blocked = required.filter((suite) => suite.result === "blocked");
  const failed = required.filter((suite) => suite.result === "failed");
  const hold = required.filter((suite) => suite.result === "hold");
  const notRun = required.filter((suite) => suite.result === "not-run");
  const deferred = required.filter((suite) => suite.result === "deferred");
  const nonNormativeAttempts = required.filter(
    (suite) => Number.isInteger(suite.attempt) && suite.attempt > 1,
  );
  const priorRequired = attemptHistory.filter((suite) =>
    ["requiredLight", "requiredHeavy", "requiredJourneys"].includes(
      suite.bucket,
    ),
  );
  const priorNonNormativeAttempts = priorRequired.filter(
    (suite) => Number.isInteger(suite.attempt) && suite.attempt > 1,
  );
  const priorNonSuccess = priorRequired.filter(
    (suite) => !["passed", "informational"].includes(suite.result),
  );
  const skippedLike = required.filter((suite) =>
    ["skipped", "deferred"].includes(suite.result),
  );

  if (blocked.length > 0) {
    reasons.push(
      `blocked required suites: ${blocked.map((s) => s.suiteId).join(", ")}`,
    );
    return { verdict: "BLOCK", reasons };
  }
  if (failed.length > 0) {
    reasons.push(
      `failed required suites: ${failed.map((s) => s.suiteId).join(", ")}`,
    );
    return { verdict: "BLOCK", reasons };
  }
  if (deferred.length > 0 || skippedLike.length > 0) {
    reasons.push("deferred/skipped required suites cannot count as PASS");
    return { verdict: "BLOCK", reasons };
  }
  if (notRun.length > 0) {
    reasons.push(
      `required suites not run: ${notRun.map((s) => s.suiteId).join(", ")}`,
    );
    return { verdict: "INCOMPLETE", reasons };
  }
  if (nonNormativeAttempts.length > 0) {
    reasons.push(
      `non-normative retry attempts cannot count as PASS: ${nonNormativeAttempts
        .map((suite) => `${suite.suiteId} Attempt ${suite.attempt}`)
        .join(", ")}`,
    );
    return { verdict: "BLOCK", reasons };
  }
  if (priorNonNormativeAttempts.length > 0 || priorNonSuccess.length > 0) {
    if (priorNonNormativeAttempts.length > 0) {
      reasons.push(
        `candidate has non-normative historical retries: ${priorNonNormativeAttempts
          .map((suite) => `${suite.suiteId} Attempt ${suite.attempt}`)
          .join(", ")}`,
      );
    }
    if (priorNonSuccess.length > 0) {
      reasons.push(
        `candidate has historical required-suite failures: ${priorNonSuccess
          .map(
            (suite) =>
              `${suite.suiteId} Attempt ${suite.attempt}=${suite.result}`,
          )
          .join(", ")}`,
      );
    }
    return { verdict: "BLOCK", reasons };
  }
  if (hold.length > 0) {
    reasons.push(
      `hold required suites: ${hold.map((s) => s.suiteId).join(", ")}`,
    );
    return { verdict: "HOLD", reasons };
  }
  if (invalidRequired.length > 0) {
    reasons.push(
      `required suites must be strictly passed: ${invalidRequired
        .map((suite) => `${suite.suiteId}=${suite.result}`)
        .join(", ")}`,
    );
    return { verdict: "BLOCK", reasons };
  }
  if (reasons.length > 0) {
    return { verdict: "BLOCK", reasons };
  }
  return {
    verdict: "PASS",
    reasons: ["all required light/heavy/journey suites passed"],
  };
}

function firstFailureOf(suites) {
  for (const suite of suites) {
    if (["failed", "blocked", "hold"].includes(suite.result)) {
      return {
        suiteId: suite.suiteId,
        result: suite.result,
        message: suite.message ?? suite.result,
      };
    }
  }
  return null;
}

export function formatCertifyMarkdown(report) {
  const lines = [
    `# Gate B2 Certification (${report.mode})`,
    "",
    `- verdict: **${report.verdict}**`,
    `- candidate commit: \`${report.candidate.commitSha ?? "(unset)"}\``,
    `- candidate tree: \`${report.candidate.treeSha ?? "(unset)"}\``,
    `- frozen: ${report.candidate.frozen ? "yes" : "no"}`,
    `- dirty: ${report.candidate.dirty ? "yes" : "no"}`,
    `- manifest: \`${report.manifestDigest}\``,
    "",
    "## Reasons",
    ...(report.verdictReasons ?? []).map((reason) => `- ${reason}`),
    "",
    "## Suites",
  ];
  for (const suite of report.suites) {
    lines.push(
      `- \`${suite.suiteId}\` [${suite.bucket}] → ${suite.result}` +
        (suite.message ? ` — ${suite.message}` : ""),
    );
  }
  if (report.firstFailure) {
    lines.push(
      "",
      "## First failure",
      `- ${report.firstFailure.suiteId}: ${report.firstFailure.message}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function loadGateB2Manifest(repoRoot = DEFAULT_REPO_ROOT) {
  const text = await readText(repoRoot, MANIFEST_RELATIVE);
  const raw = yaml.load(text);
  const errors = validateGateB2Manifest(raw);
  if (errors.length > 0) {
    throw new Error(`Invalid Gate B2 manifest:\n- ${errors.join("\n- ")}`);
  }
  return { raw, text, digest: sha256Text(text) };
}

async function runLightSuites({
  manifest,
  args,
  candidate,
  environment,
  repoRoot,
  artifactDir,
  ledgerRoot,
}) {
  if (!args.dryRun && !ledgerRoot) {
    return manifest.requiredLight.map((entry) =>
      blockedSuite({
        suiteId: entry.id,
        bucket: "requiredLight",
        message: DURABLE_ATTEMPT_LEDGER_MESSAGE,
        command: entry.command ?? null,
        environmentDigest: environment.digest,
      }),
    );
  }
  const suites = [];
  let previousFailure = null;
  for (const entry of manifest.requiredLight) {
    if (previousFailure) {
      suites.push(
        notRunSuite({
          suiteId: entry.id,
          bucket: "requiredLight",
          message: `Fail-fast after ${previousFailure}; first failure retained.`,
          command: entry.command ?? null,
        }),
      );
      continue;
    }
    const allocation =
      ledgerRoot && !args.dryRun
        ? await allocateGateB2Attempt({
            ledgerRoot,
            candidateCommitSha: candidate.commitSha,
            candidateTreeSha: candidate.treeSha,
            contractVersion: GATE_B2_CONTRACT_VERSION,
            suiteId: entry.id,
          })
        : null;
    if (entry.kind === "external-evidence" || entry.id === "full-ci") {
      const result = await evaluateFullCiEvidence({
        artifactDir,
        ciEvidence: args.ciEvidence,
        candidate,
        dryRun: args.dryRun,
        repoRoot,
        fullCiContract: manifest.fullCi ?? null,
      });
      const recorded = await recordCertificationSuiteAttempt({
        allocation,
        candidate,
        result,
      });
      suites.push(recorded);
      if (recorded.result !== "passed") previousFailure = entry.id;
      continue;
    }
    if (args.dryRun) {
      suites.push(
        notRunSuite({
          suiteId: entry.id,
          bucket: "requiredLight",
          message: "dry-run: command not executed",
          command: entry.command,
        }),
      );
      continue;
    }
    let command = [...(entry.command ?? [])];
    if (entry.injectCandidateComparison) {
      if (candidate.baseMasterSha) {
        command = [
          ...command,
          "--base",
          candidate.baseMasterSha,
          "--head",
          candidate.commitSha,
        ];
      }
      if (artifactDir) {
        command = [
          ...command,
          "--report",
          path.join(artifactDir, "light/impact.json"),
        ];
      }
    }
    const [bin, ...cmdArgs] = command;
    const captured = await runCapturedCommand(bin, cmdArgs, repoRoot);
    const suiteResult = {
      suiteId: entry.id,
      bucket: "requiredLight",
      attempt: 1,
      startedAt: captured.startedAt,
      completedAt: captured.completedAt,
      exitCode: captured.exitCode,
      environmentDigest: environment.digest,
      commandDigest: sha256Text(JSON.stringify(command)),
      stdoutDigest: captured.stdoutDigest,
      stderrDigest: captured.stderrDigest,
      artifactDigests: [],
      result: captured.status === "passed" ? "passed" : "failed",
      message:
        captured.status === "passed"
          ? "passed"
          : (captured.error ?? `exit ${captured.exitCode}`),
      command,
    };
    const recorded = await recordCertificationSuiteAttempt({
      allocation,
      candidate,
      result: suiteResult,
    });
    suites.push(recorded);
    if (recorded.result !== "passed") previousFailure = entry.id;
  }
  return suites;
}

async function resolveHeavyCommand({ entry, qualityIndex, packageJson }) {
  if (entry.qualityManifestId) {
    const heavy = qualityIndex.heavy.get(entry.qualityManifestId);
    if (heavy?.command) {
      return {
        kind: "shell-string",
        commandString: heavy.command,
        available: true,
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
    return {
      kind: "argv",
      command: resolved.command,
      available: true,
    };
  }
  return {
    kind: "missing",
    available: false,
    message: "No qualityManifestId or runner configured",
  };
}

async function runShellStringCommand(commandString, cwd, env = process.env) {
  // Strip VAR=... placeholders so parent-process secrets are inherited.
  const sanitized = stripCredentialPlaceholders(commandString);
  const started = performance.now();
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(sanitized, {
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
      const stdoutBuf = Buffer.concat(stdout);
      const stderrBuf = Buffer.concat([
        ...stderr,
        Buffer.from(String(error.message)),
      ]);
      resolve({
        status: "failed",
        exitCode: null,
        error: error.message,
        durationMs: Math.round(performance.now() - started),
        startedAt,
        completedAt: new Date().toISOString(),
        stdoutDigest: sha256Buffer(stdoutBuf),
        stderrDigest: sha256Buffer(stderrBuf),
      });
    });
    child.on("exit", (exitCode) => {
      const stdoutBuf = Buffer.concat(stdout);
      const stderrBuf = Buffer.concat(stderr);
      resolve({
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        durationMs: Math.round(performance.now() - started),
        startedAt,
        completedAt: new Date().toISOString(),
        stdoutDigest: sha256Buffer(stdoutBuf),
        stderrDigest: sha256Buffer(stderrBuf),
      });
    });
  });
}

async function runHeavySuites({
  entries,
  bucket,
  qualityIndex,
  packageJson,
  environment,
  repoRoot,
  dryRun,
  creditInformational = false,
  candidate,
  freeze,
  certificationRunId,
  artifactDir,
  ledgerRoot,
  env = process.env,
}) {
  if (!dryRun && !ledgerRoot) {
    return entries.map((entry) =>
      blockedSuite({
        suiteId: entry.id,
        bucket,
        message: DURABLE_ATTEMPT_LEDGER_MESSAGE,
        environmentDigest: environment.digest,
      }),
    );
  }
  const suites = [];
  let previousFailure = null;
  for (const entry of entries) {
    if (previousFailure && bucket === "requiredHeavy") {
      suites.push(
        notRunSuite({
          suiteId: entry.id,
          bucket,
          message: `Fail-fast after ${previousFailure}; first failure retained.`,
        }),
      );
      continue;
    }
    let allocation = null;
    if (entry.status === "blocked" || entry.id.startsWith("blocked-")) {
      const blocked = blockedSuite({
        suiteId: entry.id,
        bucket,
        environmentDigest: environment.digest,
        message:
          (entry.requiredAction
            ? String(entry.requiredAction).trim()
            : entry.reason) ||
          `Heavy suite ${entry.id} is blocked until requiredAction is satisfied.`,
      });
      const recorded = await recordCertificationSuiteAttempt({
        allocation,
        candidate,
        result: blocked,
      });
      suites.push(recorded);
      if (bucket === "requiredHeavy") previousFailure = entry.id;
      continue;
    }
    const missing = missingEnv(entry.requiresEnv);
    if (missing.length > 0) {
      const blocked = blockedSuite({
        suiteId: entry.id,
        bucket,
        environmentDigest: environment.digest,
        message: `Missing required credentials/resources: ${missing.join(", ")}. Credential shortage is BLOCK, not passed/skipped.`,
      });
      const recorded = await recordCertificationSuiteAttempt({
        allocation,
        candidate,
        result: blocked,
      });
      suites.push(recorded);
      if (bucket === "requiredHeavy") previousFailure = entry.id;
      continue;
    }
    const resolved = await resolveHeavyCommand({
      entry,
      qualityIndex,
      packageJson,
    });
    if (!resolved.available) {
      const blocked = blockedSuite({
        suiteId: entry.id,
        bucket,
        environmentDigest: environment.digest,
        message:
          resolved.message +
          (resolved.requiredAction
            ? ` Required action: ${resolved.requiredAction}`
            : ""),
      });
      const recorded = await recordCertificationSuiteAttempt({
        allocation,
        candidate,
        result: blocked,
      });
      suites.push(recorded);
      if (bucket === "requiredHeavy") previousFailure = entry.id;
      continue;
    }
    if (dryRun) {
      suites.push(
        notRunSuite({
          suiteId: entry.id,
          bucket,
          message: "dry-run: heavy suite not executed",
          command:
            resolved.kind === "argv"
              ? resolved.command
              : [stripCredentialPlaceholders(resolved.commandString)],
        }),
      );
      continue;
    }

    allocation = await allocateGateB2Attempt({
      ledgerRoot,
      candidateCommitSha: candidate.commitSha,
      candidateTreeSha: candidate.treeSha,
      contractVersion: GATE_B2_CONTRACT_VERSION,
      suiteId: entry.id,
    });

    const commandForDigest =
      resolved.kind === "argv"
        ? resolved.command
        : [stripCredentialPlaceholders(resolved.commandString)];
    const commandDigest = sha256Text(JSON.stringify(commandForDigest));
    const runId = randomUUID();
    const { attempt, attemptDir } = allocation;
    const outputPath = path.join(attemptDir, "report.json");

    const heavyEnv = buildHeavyCertificationEnv({
      candidate,
      suiteId: entry.id,
      runId,
      outputPath,
      commandDigest,
      freezeId: freeze?.freezeId,
      certificationRunId,
      attempt,
      attemptDir,
      ledgerSnapshot: allocation.ledgerSnapshot,
      baseEnv: env,
    });

    const captured =
      resolved.kind === "argv"
        ? await runCapturedCommand(
            resolved.command[0],
            resolved.command.slice(1),
            repoRoot,
            heavyEnv,
          )
        : await runShellStringCommand(
            resolved.commandString,
            repoRoot,
            heavyEnv,
          );

    let result =
      captured.status === "passed"
        ? creditInformational
          ? "informational"
          : "passed"
        : "failed";
    let message =
      result === "informational"
        ? "completed without certification credit"
        : (captured.error ?? result);

    if (entry.certificationCredit === false && captured.status === "passed") {
      result = "informational";
      message = "completed without certification credit";
    }

    const bindingExpected = {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      suiteId: entry.id,
      runId,
      commandDigest,
      freezeId: freeze?.freezeId,
      certificationRunId,
      attempt,
    };
    const artifactDigests = [];

    if (captured.status === "passed") {
      let liveReport = await readHeavyLiveReport(artifactDir, entry.id, {
        outputPath,
        env: heavyEnv,
      });

      if (
        bucket === "requiredHeavy" &&
        entry.id === "heavy-narrative-chronicle-production"
      ) {
        const validation = validateChronicleProductionReport(
          liveReport,
          candidate,
          bindingExpected,
        );
        if (!validation.ok) {
          result = "failed";
          message = validation.message;
        }
      }
      if (entry.id === "heavy-web-ai-consent-live" && result !== "failed") {
        const validation = validateWebAiConsentReport(
          liveReport,
          bindingExpected,
        );
        if (!validation.ok && bucket === "requiredHeavy") {
          result = "failed";
          message = validation.message;
        }
      }
      if (
        entry.id === "heavy-web-ai-consent-browser-live" &&
        result !== "failed"
      ) {
        const validation = validateWebAiConsentBrowserReport(
          liveReport,
          bindingExpected,
        );
        if (!validation.ok && bucket === "requiredHeavy") {
          result = "failed";
          message = validation.message;
        }
      }

      if (liveReport && result !== "failed") {
        let digest;
        if (await pathExists(outputPath)) {
          digest = sha256Text(await readFile(outputPath, "utf8"));
        } else {
          digest = await persistHeavyReport({
            report: liveReport,
            artifactDir,
            suiteId: entry.id,
            attemptDir,
          });
        }
        artifactDigests.push(digest);
      } else if (
        bucket === "requiredHeavy" &&
        result === "passed" &&
        [
          "heavy-narrative-chronicle-production",
          "heavy-web-ai-consent-live",
          "heavy-web-ai-consent-browser-live",
        ].includes(entry.id)
      ) {
        result = "failed";
        message =
          message || "heavy report missing or failed binding validation";
      }
    }

    const suiteResult = {
      suiteId: entry.id,
      bucket,
      attempt,
      startedAt: captured.startedAt,
      completedAt: captured.completedAt,
      exitCode: captured.exitCode,
      environmentDigest: environment.digest,
      commandDigest,
      stdoutDigest: captured.stdoutDigest,
      stderrDigest: captured.stderrDigest,
      artifactDigests,
      result,
      message,
      command: commandForDigest,
      runId,
    };
    await writeGateB2AttemptRecord({
      attemptDir,
      record: {
        schemaVersion: 1,
        contractVersion: GATE_B2_CONTRACT_VERSION,
        attemptLedgerId: allocation.ledgerIdentity.attemptLedgerId,
        attemptLedgerConfigDigest:
          allocation.ledgerIdentity.attemptLedgerConfigDigest,
        attemptLedgerInstanceId:
          allocation.ledgerIdentity.attemptLedgerInstanceId,
        controllerReceiptDigest: allocation.ledgerIdentity.controllerReceiptDigest,
        attemptLedgerAttestation:
          allocation.ledgerIdentity.attemptLedgerAttestation,
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        freezeId: freeze?.freezeId ?? null,
        certificationRunId: certificationRunId ?? null,
        suiteId: entry.id,
        bucket,
        attempt,
        sequence: allocation.sequence,
        previousRecordDigest: allocation.previousRecordDigest,
        runId,
        commandDigest,
        startedAt: captured.startedAt,
        completedAt: captured.completedAt,
        exitCode: captured.exitCode,
        environmentDigest: environment.digest,
        stdoutDigest: captured.stdoutDigest,
        stderrDigest: captured.stderrDigest,
        artifactDigests,
        result,
        message,
      },
    });
    suites.push(suiteResult);
    if (
      bucket === "requiredHeavy" &&
      !["passed", "informational"].includes(suiteResult.result)
    ) {
      previousFailure = entry.id;
    }
  }
  return suites;
}

export async function certifyGateB2({
  repoRoot = DEFAULT_REPO_ROOT,
  args,
  freezePath = null,
  freezeDocument = null,
  boundExecution = false,
}) {
  const startedAt = new Date().toISOString();
  const certificationRunId = randomUUID();
  const needsExecution =
    args.runLight ||
    args.runHeavy ||
    args.runJourneys ||
    args.runInformational ||
    args.runReleaseAdjacent;
  const freeze =
    freezeDocument ??
    (await loadFreezeDocument(repoRoot, freezePath ?? FREEZE_RELATIVE));
  let executionRoot = repoRoot;
  let cleanup = async () => {};
  let boundVia = "unbound";

  try {
    const { raw: manifestProbe } = await loadGateB2Manifest(repoRoot);
    if (needsExecution && freeze && args.candidate) {
      assertFreezeActive(freeze);
      if (freeze.contractVersion !== GATE_B2_CONTRACT_VERSION) {
        throw new Error(
          `Freeze contractVersion ${freeze.contractVersion} != ${GATE_B2_CONTRACT_VERSION}`,
        );
      }
    }
    if (needsExecution) {
      if (!args.candidate) {
        if (!args.dryRun) {
          throw new Error(
            "--candidate <frozen-sha> is required when running light/heavy/journeys",
          );
        }
        // Dry-run without candidate stays unbound (unit tests / local probes only).
        boundVia = "dry-run-unbound";
      } else {
        if (!freeze) {
          throw new Error(
            "Freeze file missing; run pnpm certify:gate-b2:freeze before certification runs",
          );
        }
        const requireTree =
          manifestProbe.decisionPolicy?.requireTreeShaMatch !== false;
        try {
          const bound = await bindExecutionRoot({
            repoRoot,
            candidateSha: args.candidate,
            freeze,
            requireTreeShaMatch: requireTree,
            createWorktree: boundExecution ? false : !args.dryRun,
          });
          executionRoot = bound.executionRoot;
          cleanup = bound.cleanup;
          boundVia =
            boundExecution && bound.identity.boundVia === "head-match"
              ? "bootstrap-detached-worktree"
              : bound.identity.boundVia;
        } catch (headMatchError) {
          if (args.dryRun) {
            const bound = await bindExecutionRoot({
              repoRoot,
              candidateSha: args.candidate,
              freeze,
              requireTreeShaMatch: requireTree,
              createWorktree: true,
            });
            executionRoot = bound.executionRoot;
            cleanup = bound.cleanup;
            boundVia = bound.identity.boundVia;
          } else {
            throw headMatchError;
          }
        }
        if (executionRoot !== repoRoot) {
          await prepareWorktreeDependencies({ repoRoot, executionRoot });
        }
      }
    }

    const { raw: manifest, digest: manifestDigest } =
      await loadGateB2Manifest(executionRoot);
    const qualityText = await readText(
      executionRoot,
      QUALITY_MANIFEST_RELATIVE,
    );
    const qualityManifest = yaml.load(qualityText);
    const qualityIndex = parseQualityHeavyIndex(qualityManifest);
    const packageJson = JSON.parse(
      await readText(executionRoot, "package.json"),
    );
    const environment = environmentInfo();
    const identity = await resolveCandidateIdentity({
      candidate: args.candidate ?? undefined,
      baseMaster: args.baseMaster ?? undefined,
      repoRoot: executionRoot,
    });
    if (needsExecution && freeze && boundVia !== "dry-run-unbound") {
      identity.baseMasterSha = freeze.candidate.baseMasterSha;
      if (args.baseMaster) {
        const resolvedBase = (
          await runGit(["rev-parse", args.baseMaster], executionRoot)
        ).toLowerCase();
        if (resolvedBase !== freeze.candidate.baseMasterSha) {
          throw new Error(
            `--base-master ${resolvedBase} conflicts with freeze baseMasterSha ${freeze.candidate.baseMasterSha}`,
          );
        }
      }
    }
    const digests = await collectInputDigests(manifest, executionRoot, {
      manifestDigest,
    });

    if (needsExecution && freeze && boundVia !== "dry-run-unbound") {
      const digestErrors = assertDigestsMatchFreeze(digests, freeze.candidate, {
        contractVersion: freeze.contractVersion,
      });
      if (digestErrors.length > 0) {
        throw new Error(
          `Execution digests drifted from freeze:\n- ${digestErrors.join("\n- ")}`,
        );
      }
      if (identity.commitSha !== freeze.candidate.commitSha) {
        throw new Error("Execution commit SHA drifted from freeze");
      }
      if (identity.treeSha !== freeze.candidate.treeSha) {
        throw new Error("Execution tree SHA drifted from freeze");
      }
    }

    const frozen =
      Boolean(args.candidate) &&
      Boolean(freeze) &&
      freeze.candidate.commitSha === identity.commitSha &&
      freeze.candidate.treeSha === identity.treeSha &&
      !identity.dirty;
    const candidate = {
      commitSha: identity.commitSha,
      treeSha: identity.treeSha,
      baseMasterSha: identity.baseMasterSha,
      schemaVersion: manifest.candidate.schemaVersion,
      freezeId: freeze?.freezeId ?? null,
      ...getGateB2AttemptLedgerIdentity(),
      ...digests,
      frozen,
      dirty: identity.dirty,
      boundVia,
    };

    const artifactDir =
      args.artifactDir ??
      path.join(
        repoRoot,
        ".artifacts/gate-b2",
        candidate.commitSha ?? "unfrozen",
      );
    await mkdir(artifactDir, { recursive: true });
    await mkdir(path.join(artifactDir, "light"), { recursive: true });
    await mkdir(path.join(artifactDir, "heavy"), { recursive: true });
    await mkdir(path.join(artifactDir, "journeys"), { recursive: true });
    await mkdir(path.join(artifactDir, "environment"), { recursive: true });
    const configuredAttemptLedgerRoot = resolveAttemptLedgerRoot({
      repoRoot,
      configuredRoot: args.attemptLedgerRoot,
    });
    const suiteBuckets = Object.fromEntries([
      ...manifest.requiredLight.map((entry) => [entry.id, "requiredLight"]),
      ...manifest.requiredHeavy.map((entry) => [entry.id, "requiredHeavy"]),
      ...manifest.requiredManualJourneys.map((entry) => [
        entry.id,
        "requiredJourneys",
      ]),
      ...manifest.informational.map((entry) => [entry.id, "informational"]),
      ...manifest.releaseAdjacent.map((entry) => [entry.id, "releaseAdjacent"]),
    ]);
    let attemptLedgerSnapshot = null;
    let attemptLedgerError = null;
    if (candidate.frozen && !args.dryRun) {
      try {
        attemptLedgerSnapshot = await loadGateB2AttemptLedgerSnapshot({
          ledgerRoot: configuredAttemptLedgerRoot,
          candidateCommitSha: candidate.commitSha,
          candidateTreeSha: candidate.treeSha,
          contractVersion: GATE_B2_CONTRACT_VERSION,
          suiteBuckets,
        });
        const frozenLedger = freeze?.candidate ?? freeze ?? {};
        if (
          frozenLedger.attemptLedgerInstanceId &&
          frozenLedger.attemptLedgerInstanceId !==
            attemptLedgerSnapshot.attemptLedgerInstanceId
        ) {
          throw new Error(
            "controller-provisioned Gate B2 ledger instance does not match freeze",
          );
        }
      } catch (error) {
        attemptLedgerError = error;
        attemptLedgerSnapshot = null;
      }
    }
    if (attemptLedgerSnapshot) {
      Object.assign(candidate, attemptLedgerSnapshot);
    }
    const attemptLedgerRoot =
      attemptLedgerError || (needsExecution && !args.dryRun && !candidate.frozen)
        ? null
        : configuredAttemptLedgerRoot;
    let attemptHistory = attemptLedgerSnapshot
      ? attemptLedgerSnapshot.history
      : [];

    const suites = [];
    const retries = [];
    const blockedReasons = [];
    const certEnv = sanitizeCertificationEnv(process.env);

    if (args.preflight || needsExecution) {
      if (candidate.dirty) blockedReasons.push("working tree dirty");
      if (needsExecution && !candidate.frozen) {
        blockedReasons.push("candidate not freeze-bound");
      }
      if (needsExecution && !args.dryRun && !attemptLedgerRoot) {
        blockedReasons.push(
          attemptLedgerError?.message ?? DURABLE_ATTEMPT_LEDGER_MESSAGE,
        );
      }
      for (const [key, value] of Object.entries(digests)) {
        if (!SHA256_RE.test(value)) {
          blockedReasons.push(`invalid digest for ${key}`);
        }
      }
    }

    if (args.runLight) {
      suites.push(
        ...(await runLightSuites({
          manifest,
          args,
          candidate,
          environment,
          repoRoot: executionRoot,
          artifactDir,
          ledgerRoot: attemptLedgerRoot,
        })),
      );
    } else {
      for (const entry of manifest.requiredLight) {
        suites.push(
          notRunSuite({
            suiteId: entry.id,
            bucket: "requiredLight",
            message: "not requested (--run-light)",
            command: entry.command ?? null,
          }),
        );
      }
    }

    if (args.runHeavy) {
      suites.push(
        ...(await runHeavySuites({
          entries: manifest.requiredHeavy,
          bucket: "requiredHeavy",
          qualityIndex,
          packageJson,
          environment,
          repoRoot: executionRoot,
          dryRun: args.dryRun,
          candidate,
          freeze,
          certificationRunId,
          artifactDir,
          ledgerRoot: attemptLedgerRoot,
          env: certEnv,
        })),
      );
    } else {
      for (const entry of manifest.requiredHeavy) {
        suites.push(
          notRunSuite({
            suiteId: entry.id,
            bucket: "requiredHeavy",
            message: "not requested (--run-heavy)",
          }),
        );
      }
    }

    if (args.runJourneys) {
      if (!args.dryRun && !attemptLedgerRoot) {
        suites.push(
          ...manifest.requiredManualJourneys.map((entry) =>
            blockedSuite({
              suiteId: entry.id,
              bucket: "requiredJourneys",
              message: DURABLE_ATTEMPT_LEDGER_MESSAGE,
              command: entry.command ?? null,
              environmentDigest: environment.digest,
            }),
          ),
        );
      } else {
        for (const entry of manifest.requiredManualJourneys) {
          const allocation = args.dryRun
            ? null
            : await allocateGateB2Attempt({
                ledgerRoot: attemptLedgerRoot,
                candidateCommitSha: candidate.commitSha,
                candidateTreeSha: candidate.treeSha,
                contractVersion: GATE_B2_CONTRACT_VERSION,
                suiteId: entry.id,
              });
          const result = await runJourneySuite({
            journeyEntry: entry,
            candidate,
            environment,
            repoRoot: executionRoot,
            dryRun: args.dryRun,
            freeze,
            certificationRunId,
            allocation,
            env: certEnv,
          });
          suites.push(
            await recordCertificationSuiteAttempt({
              allocation,
              candidate,
              result,
            }),
          );
        }
      }
    } else {
      for (const entry of manifest.requiredManualJourneys) {
        suites.push(
          notRunSuite({
            suiteId: entry.id,
            bucket: "requiredJourneys",
            message: "not requested (--run-journeys)",
          }),
        );
      }
    }

    if (args.runInformational) {
      suites.push(
        ...(await runHeavySuites({
          entries: manifest.informational,
          bucket: "informational",
          qualityIndex,
          packageJson,
          environment,
          repoRoot: executionRoot,
          dryRun: args.dryRun,
          creditInformational: true,
          candidate,
          freeze,
          certificationRunId,
          artifactDir,
          ledgerRoot: attemptLedgerRoot,
          env: certEnv,
        })),
      );
    } else {
      for (const entry of manifest.informational) {
        suites.push(
          notRunSuite({
            suiteId: entry.id,
            bucket: "informational",
            message: "not requested (--run-informational)",
          }),
        );
      }
    }

    if (args.runReleaseAdjacent) {
      for (const entry of manifest.releaseAdjacent) {
        if (entry.status === "blocked" || entry.id.startsWith("blocked-")) {
          const blocked = qualityIndex.blocked.get(
            entry.qualityManifestId ?? entry.id,
          );
          suites.push(
            blockedSuite({
              suiteId: entry.id,
              bucket: "releaseAdjacent",
              environmentDigest: environment.digest,
              message:
                blocked?.reason ??
                "Release-adjacent blocked evaluation; not part of Gate B2 Engineering PASS.",
            }),
          );
          continue;
        }
        suites.push(
          ...(await runHeavySuites({
            entries: [entry],
            bucket: "releaseAdjacent",
            qualityIndex,
            packageJson,
            environment,
            repoRoot: executionRoot,
            dryRun: args.dryRun,
            candidate,
            freeze,
            certificationRunId,
            artifactDir,
            ledgerRoot: attemptLedgerRoot,
            env: certEnv,
          })),
        );
      }
    } else {
      for (const entry of manifest.releaseAdjacent) {
        suites.push(
          notRunSuite({
            suiteId: entry.id,
            bucket: "releaseAdjacent",
            message:
              "not requested (--run-release-adjacent); not required for Gate B2 Engineering",
          }),
        );
      }
    }

    for (const suite of suites) {
      if (suite.result === "blocked") {
        blockedReasons.push(`${suite.suiteId}: ${suite.message}`);
      }
      if (Number.isInteger(suite.attempt) && suite.attempt > 1) {
        retries.push({
          suiteId: suite.suiteId,
          attempt: suite.attempt,
          result: suite.result,
          normative: false,
          message: suite.message,
        });
      }
    }

    if (candidate.frozen && !args.dryRun && attemptLedgerRoot) {
      try {
        const finalLedgerSnapshot = await loadGateB2AttemptLedgerSnapshot({
          ledgerRoot: attemptLedgerRoot,
          candidateCommitSha: candidate.commitSha,
          candidateTreeSha: candidate.treeSha,
          contractVersion: GATE_B2_CONTRACT_VERSION,
          suiteBuckets,
        });
        Object.assign(candidate, finalLedgerSnapshot);
        attemptHistory = finalLedgerSnapshot.history;
      } catch (error) {
        blockedReasons.push(`final attempt ledger snapshot invalid: ${error.message}`);
      }
    }

    const preflightOnly =
      args.preflight &&
      !args.runLight &&
      !args.runHeavy &&
      !args.runJourneys &&
      !args.runInformational &&
      !args.runReleaseAdjacent;

    const mode = preflightOnly
      ? "preflight"
      : args.runLight && args.runHeavy && args.runJourneys
        ? "full"
        : args.runHeavy
          ? "heavy"
          : args.runLight
            ? "light"
            : args.runJourneys
              ? "journeys"
              : "decision";

    const decision = decideVerdict({
      suites,
      candidate,
      decisionPolicy: manifest.decisionPolicy ?? {},
      preflightOnly,
      attemptHistory,
    });
    if (
      blockedReasons.length > 0 &&
      decision.verdict === "PASS" &&
      !preflightOnly
    ) {
      decision.verdict = "BLOCK";
      decision.reasons.push(...blockedReasons);
    }

    if (needsExecution && boundVia !== "dry-run-unbound") {
      try {
        await assertWorkingTreeClean(executionRoot);
      } catch (error) {
        blockedReasons.push(error.message);
        if (decision.verdict === "PASS") {
          decision.verdict = "BLOCK";
          decision.reasons.push(error.message);
        }
      }
    }

    const report = {
      schemaVersion: 1,
      contractVersion: GATE_B2_CONTRACT_VERSION,
      gateId: "gate-b2",
      manifestDigest,
      generatedAt: new Date().toISOString(),
      startedAt,
      completedAt: new Date().toISOString(),
      freezeId: freeze?.freezeId ?? null,
      certificationRunId,
      mode,
      candidate,
      environment,
      verdict: decision.verdict,
      verdictReasons: [...decision.reasons, ...blockedReasons].filter(
        (value, index, all) => all.indexOf(value) === index,
      ),
      summary: {
        requiredLight: tallyBucket(suites, "requiredLight"),
        requiredHeavy: tallyBucket(suites, "requiredHeavy"),
        requiredJourneys: tallyBucket(suites, "requiredJourneys"),
        informational: tallyBucket(suites, "informational"),
        releaseAdjacent: tallyBucket(suites, "releaseAdjacent"),
      },
      suites,
      retries,
      blockedReasons,
      firstFailure: firstFailureOf(suites),
    };

    const reportSchema = JSON.parse(
      await readText(executionRoot, REPORT_SCHEMA_RELATIVE),
    );
    const reportValidation = validateJsonAgainstSchema(report, reportSchema);
    if (!reportValidation.ok) {
      throw new Error(
        `Gate B2 report schema validation failed: ${JSON.stringify(reportValidation.errors)}`,
      );
    }

    const defaultReportPath = path.join(artifactDir, "report.json");
    const reportPath = args.report
      ? path.isAbsolute(args.report)
        ? args.report
        : path.join(repoRoot, args.report)
      : defaultReportPath;
    await mkdir(path.dirname(reportPath), { recursive: true });
    const reportJson = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, reportJson, "utf8");
    const reportDigest = sha256Text(reportJson);
    await writeFile(`${reportPath}.sha256`, `${reportDigest}\n`, "utf8");

    const decisionPath = path.join(artifactDir, "decision.json");
    const decisionDoc = buildDecisionDocument({
      candidate,
      freezeId: freeze?.freezeId ?? null,
      certificationRunId,
      verdict: report.verdict,
      reasons: report.verdictReasons,
      suites,
      attemptHistory,
      reportDigest,
      digests,
    });
    const decisionSchema = JSON.parse(
      await readText(executionRoot, DECISION_SCHEMA_RELATIVE),
    );
    const decisionValidation = validateJsonAgainstSchema(
      decisionDoc,
      decisionSchema,
    );
    if (!decisionValidation.ok) {
      throw new Error(
        `Gate B2 decision schema validation failed: ${JSON.stringify(decisionValidation.errors)}`,
      );
    }
    await writeFile(
      decisionPath,
      `${JSON.stringify(decisionDoc, null, 2)}\n`,
      "utf8",
    );

    await writeFile(
      path.join(artifactDir, "manifest.json"),
      `${JSON.stringify(
        {
          source: MANIFEST_RELATIVE,
          digest: manifestDigest,
          candidate,
          freezeBound: Boolean(freeze),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    return {
      report: { ...report, reportDigest },
      reportPath,
      artifactDir,
      decisionPath,
    };
  } finally {
    await cleanup();
  }
}

async function main() {
  const args = parseCertifyArgs(process.argv.slice(2));
  const needsExecution =
    args.runLight ||
    args.runHeavy ||
    args.runJourneys ||
    args.runInformational ||
    args.runReleaseAdjacent;
  const boundExecution = process.env.GATE_B2_BOUND_EXECUTION === "1";
  if (needsExecution && !boundExecution) {
    throw new Error(
      "Certification execution must be launched through certify-gate-b2-bootstrap.mjs",
    );
  }
  const { report, reportPath } = await certifyGateB2({
    repoRoot: DEFAULT_REPO_ROOT,
    args,
    freezePath: process.env.GATE_B2_FREEZE_PATH || null,
    boundExecution,
  });
  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatCertifyMarkdown(report));
    process.stderr.write(`report: ${reportPath}\n`);
  }
  process.exitCode = certificationExitCode(report);
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
