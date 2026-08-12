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

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import yaml from "js-yaml";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MANIFEST_RELATIVE = "evals/certifications/gate-b2.yaml";
const QUALITY_MANIFEST_RELATIVE = "evals/quality-manifest.yaml";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

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
  for (const suite of suites.filter((entry) => entry.bucket === bucket)) {
    summary.total += 1;
    switch (suite.result) {
      case "passed":
      case "informational":
        summary.passed += 1;
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

export function validateGateB2Manifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return ["manifest must be an object"];
  }
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (raw.id !== "gate-b2") errors.push("id must be gate-b2");
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
  }
  const heavyIds = new Set();
  for (const entry of raw.requiredHeavy ?? []) {
    if (!entry?.id) errors.push("requiredHeavy entry missing id");
    else if (heavyIds.has(entry.id))
      errors.push(`duplicate requiredHeavy id: ${entry.id}`);
    else heavyIds.add(entry.id);
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

export async function resolveCandidateIdentity(
  {
    candidate,
    baseMaster,
    repoRoot = DEFAULT_REPO_ROOT,
  } = {},
) {
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

export async function collectInputDigests(manifest, repoRoot = DEFAULT_REPO_ROOT) {
  const inputs = manifest.inputs ?? {};
  return {
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

export async function runCapturedCommand(command, args, cwd) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const usesWindowsCommandShell =
      process.platform === "win32" && command === "pnpm";
    const executable = usesWindowsCommandShell
      ? (process.env.ComSpec ?? "cmd.exe")
      : command;
    const commandArgs = usesWindowsCommandShell
      ? ["/d", "/s", "/c", command, ...args]
      : args;
    const child = spawn(executable, commandArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: process.env,
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
  candidateCommitSha,
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
  if (raw.commitSha && raw.commitSha !== candidateCommitSha) {
    return {
      suiteId: "full-ci",
      bucket: "requiredLight",
      attempt: 1,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 1,
      environmentDigest: null,
      commandDigest: null,
      stdoutDigest: null,
      stderrDigest: null,
      artifactDigests: [digest],
      result: "failed",
      message: `full-ci evidence commitSha ${raw.commitSha} does not match candidate ${candidateCommitSha}`,
    };
  }
  const conclusion = String(raw.conclusion ?? raw.status ?? "").toLowerCase();
  const passed =
    conclusion === "success" ||
    conclusion === "passed" ||
    raw.passed === true;
  return {
    suiteId: "full-ci",
    bucket: "requiredLight",
    attempt: 1,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: passed ? 0 : 1,
    environmentDigest: null,
    commandDigest: null,
    stdoutDigest: null,
    stderrDigest: null,
    artifactDigests: [digest],
    result: passed ? "passed" : "failed",
    message: passed
      ? `full-ci evidence accepted from ${evidencePath}`
      : `full-ci evidence is not successful (${conclusion || "unknown"})`,
  };
}

async function evaluateJourneyEvidence({
  journeyId,
  artifactDir,
  journeyEvidenceDir,
}) {
  const baseDir =
    journeyEvidenceDir ??
    (artifactDir ? path.join(artifactDir, "journeys") : null);
  if (!baseDir) {
    return blockedSuite({
      suiteId: journeyId,
      bucket: "requiredJourneys",
      message:
        "Journey evidence directory missing. Provide --journey-evidence-dir or journeys/ under artifact dir.",
    });
  }
  const evidencePath = path.join(baseDir, `${journeyId}.json`);
  if (!(await pathExists(evidencePath))) {
    return blockedSuite({
      suiteId: journeyId,
      bucket: "requiredJourneys",
      message: `Journey evidence missing: ${evidencePath}`,
    });
  }
  const raw = JSON.parse(await readFile(evidencePath, "utf8"));
  const digest = sha256Text(JSON.stringify(raw));
  const result = String(raw.result ?? raw.status ?? "").toLowerCase();
  if (result === "passed" || raw.passed === true) {
    return {
      suiteId: journeyId,
      bucket: "requiredJourneys",
      attempt: 1,
      startedAt: raw.startedAt ?? new Date().toISOString(),
      completedAt: raw.completedAt ?? new Date().toISOString(),
      exitCode: 0,
      environmentDigest: null,
      commandDigest: null,
      stdoutDigest: null,
      stderrDigest: null,
      artifactDigests: [digest],
      result: "passed",
      message: `Journey evidence accepted: ${evidencePath}`,
    };
  }
  if (result === "hold") {
    return {
      suiteId: journeyId,
      bucket: "requiredJourneys",
      attempt: 1,
      startedAt: raw.startedAt ?? null,
      completedAt: raw.completedAt ?? new Date().toISOString(),
      exitCode: null,
      environmentDigest: null,
      commandDigest: null,
      stdoutDigest: null,
      stderrDigest: null,
      artifactDigests: [digest],
      result: "hold",
      message: raw.message ?? "Journey recorded HOLD",
    };
  }
  return {
    suiteId: journeyId,
    bucket: "requiredJourneys",
    attempt: 1,
    startedAt: raw.startedAt ?? null,
    completedAt: raw.completedAt ?? new Date().toISOString(),
    exitCode: 1,
    environmentDigest: null,
    commandDigest: null,
    stdoutDigest: null,
    stderrDigest: null,
    artifactDigests: [digest],
    result: result === "blocked" ? "blocked" : "failed",
    message: raw.message ?? `Journey evidence result=${result || "unknown"}`,
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
  const blocked = required.filter((suite) => suite.result === "blocked");
  const failed = required.filter((suite) => suite.result === "failed");
  const hold = required.filter((suite) => suite.result === "hold");
  const notRun = required.filter((suite) => suite.result === "not-run");
  const deferred = required.filter((suite) => suite.result === "deferred");
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
  if (hold.length > 0) {
    reasons.push(
      `hold required suites: ${hold.map((s) => s.suiteId).join(", ")}`,
    );
    return { verdict: "HOLD", reasons };
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
}) {
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
    if (entry.kind === "external-evidence" || entry.id === "full-ci") {
      const result = await evaluateFullCiEvidence({
        artifactDir,
        ciEvidence: args.ciEvidence,
        candidateCommitSha: candidate.commitSha,
      });
      suites.push(result);
      if (result.result !== "passed") previousFailure = entry.id;
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
          : captured.error ?? `exit ${captured.exitCode}`,
      command,
    };
    suites.push(suiteResult);
    if (suiteResult.result !== "passed") previousFailure = entry.id;
  }
  return suites;
}

async function resolveHeavyCommand({
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

async function runShellStringCommand(commandString, cwd) {
  // Heavy commands in quality-manifest are shell strings with env assignments.
  // We still refuse to treat missing credentials as pass; caller checks env first.
  const started = performance.now();
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(commandString, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: process.env,
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
}) {
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
    const missing = missingEnv(entry.requiresEnv);
    if (missing.length > 0) {
      const blocked = blockedSuite({
        suiteId: entry.id,
        bucket,
        environmentDigest: environment.digest,
        message: `Missing required credentials/resources: ${missing.join(", ")}. Credential shortage is BLOCK, not passed/skipped.`,
      });
      suites.push(blocked);
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
      suites.push(blocked);
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
              : [resolved.commandString],
        }),
      );
      continue;
    }
    const captured =
      resolved.kind === "argv"
        ? await runCapturedCommand(
            resolved.command[0],
            resolved.command.slice(1),
            repoRoot,
          )
        : await runShellStringCommand(resolved.commandString, repoRoot);
    const commandForDigest =
      resolved.kind === "argv" ? resolved.command : [resolved.commandString];
    let result =
      captured.status === "passed"
        ? creditInformational
          ? "informational"
          : "passed"
        : "failed";
    if (entry.certificationCredit === false && captured.status === "passed") {
      result = "informational";
    }
    const suiteResult = {
      suiteId: entry.id,
      bucket,
      attempt: 1,
      startedAt: captured.startedAt,
      completedAt: captured.completedAt,
      exitCode: captured.exitCode,
      environmentDigest: environment.digest,
      commandDigest: sha256Text(JSON.stringify(commandForDigest)),
      stdoutDigest: captured.stdoutDigest,
      stderrDigest: captured.stderrDigest,
      artifactDigests: [],
      result,
      message:
        result === "informational"
          ? "completed without certification credit"
          : captured.error ?? result,
      command: commandForDigest,
    };
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
}) {
  const startedAt = new Date().toISOString();
  const { raw: manifest, digest: manifestDigest } =
    await loadGateB2Manifest(repoRoot);
  const qualityText = await readText(repoRoot, QUALITY_MANIFEST_RELATIVE);
  const qualityManifest = yaml.load(qualityText);
  const qualityIndex = parseQualityHeavyIndex(qualityManifest);
  const packageJson = JSON.parse(await readText(repoRoot, "package.json"));
  const environment = environmentInfo();
  const identity = await resolveCandidateIdentity({
    candidate: args.candidate ?? undefined,
    baseMaster: args.baseMaster ?? undefined,
    repoRoot,
  });
  const digests = await collectInputDigests(manifest, repoRoot);
  const frozen = Boolean(args.candidate) && COMMIT_RE.test(identity.commitSha);
  const candidate = {
    commitSha: identity.commitSha,
    treeSha: identity.treeSha,
    baseMasterSha: identity.baseMasterSha,
    schemaVersion: manifest.candidate?.schemaVersion ?? 16,
    ...digests,
    frozen,
    dirty: identity.dirty,
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

  const suites = [];
  const retries = [];
  const blockedReasons = [];

  // Preflight always records candidate + digest checks.
  if (args.preflight || args.runLight || args.runHeavy || args.runJourneys) {
    if (candidate.dirty) {
      blockedReasons.push("working tree dirty");
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
        repoRoot,
        artifactDir,
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
        repoRoot,
        dryRun: args.dryRun,
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
    for (const entry of manifest.requiredManualJourneys) {
      suites.push(
        await evaluateJourneyEvidence({
          journeyId: entry.id,
          artifactDir,
          journeyEvidenceDir: args.journeyEvidenceDir,
        }),
      );
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
        repoRoot,
        dryRun: args.dryRun,
        creditInformational: true,
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
          repoRoot,
          dryRun: args.dryRun,
        })),
      );
    }
  } else {
    for (const entry of manifest.releaseAdjacent) {
      suites.push(
        notRunSuite({
          suiteId: entry.id,
          bucket: "releaseAdjacent",
          message: "not requested (--run-release-adjacent); not required for Gate B2 Engineering",
        }),
      );
    }
  }

  for (const suite of suites) {
    if (suite.result === "blocked") {
      blockedReasons.push(`${suite.suiteId}: ${suite.message}`);
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
            : "preflight";

  const decision = decideVerdict({
    suites,
    candidate,
    decisionPolicy: manifest.decisionPolicy ?? {},
    preflightOnly,
  });

  const report = {
    schemaVersion: 1,
    gateId: "gate-b2",
    manifestDigest,
    generatedAt: new Date().toISOString(),
    startedAt,
    completedAt: new Date().toISOString(),
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
    artifactDigests: [],
    blockedReasons,
    firstFailure: firstFailureOf(suites),
  };

  const defaultReportPath = path.join(artifactDir, "report.json");
  const reportPath = args.report
    ? path.isAbsolute(args.report)
      ? args.report
      : path.join(repoRoot, args.report)
    : defaultReportPath;
  await mkdir(path.dirname(reportPath), { recursive: true });
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, reportJson, "utf8");
  report.artifactDigests.push({
    path: path.relative(repoRoot, reportPath),
    digest: sha256Text(reportJson),
  });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const decisionPath = path.join(artifactDir, "decision.json");
  const decisionDoc = {
    schemaVersion: 1,
    gateId: "gate-b2",
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    verdict: report.verdict,
    reasons: report.verdictReasons,
    reportDigest: report.artifactDigests[0]?.digest ?? null,
    generatedAt: report.completedAt,
  };
  await writeFile(
    decisionPath,
    `${JSON.stringify(decisionDoc, null, 2)}\n`,
    "utf8",
  );

  const manifestCopyPath = path.join(artifactDir, "manifest.json");
  await writeFile(
    manifestCopyPath,
    `${JSON.stringify(
      {
        source: MANIFEST_RELATIVE,
        digest: manifestDigest,
        candidate,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { report, reportPath, artifactDir, decisionPath };
}

async function main() {
  const args = parseCertifyArgs(process.argv.slice(2));
  const { report, reportPath } = await certifyGateB2({
    repoRoot: DEFAULT_REPO_ROOT,
    args,
  });
  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatCertifyMarkdown(report));
    process.stderr.write(`report: ${reportPath}\n`);
  }
  if (report.verdict === "PASS") process.exitCode = 0;
  else if (report.verdict === "INCOMPLETE" && args.preflight) process.exitCode = 0;
  else process.exitCode = 1;
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
