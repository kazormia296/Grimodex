#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG_DIGEST,
} from "../electron/scripts/product-journey-catalog.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const registryPath = path.join(repoRoot, "scripts/local-ci-registry.json");
const execFileAsync = promisify(execFile);
const LOCAL_CI_RECEIPT_VERSION = 3;
const PRODUCT_JOURNEY_RESULTS_VERSION = 4;
const PRODUCT_JOURNEY_ARTIFACT_DIR = ".artifacts/product-journeys";
const PRODUCT_JOURNEY_BUILD_ARTIFACT_NAMES = [
  "Electron main",
  "renderer",
  "N-API native module",
  "MCP sidecar",
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function validateEnvironment(value, label) {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    requireString(key, `${label} key`);
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
  }
}

function validateWorkingDirectory(value, label) {
  if (value === undefined) return;
  requireString(value, label);
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must stay inside the repository`);
  }
}

export function validateLocalCiRegistry(registry) {
  if (!isPlainObject(registry) || registry.version !== 1) {
    throw new Error("local CI registry version must be 1");
  }
  requireString(registry.defaultBase, "local CI defaultBase");
  if (!isPlainObject(registry.profiles)) {
    throw new Error("local CI profiles must be an object");
  }
  if (!isPlainObject(registry.stages)) {
    throw new Error("local CI stages must be an object");
  }
  if (!isPlainObject(registry.hostedJobs)) {
    throw new Error("local CI hostedJobs must be an object");
  }

  for (const [stageId, stage] of Object.entries(registry.stages)) {
    requireString(stageId, "local CI stage id");
    if (!isPlainObject(stage)) {
      throw new Error(`local CI stage ${stageId} must be an object`);
    }
    requireString(stage.label, `local CI stage ${stageId} label`);
    validateEnvironment(stage.env, `local CI stage ${stageId} env`);
    if (!Array.isArray(stage.commands) || stage.commands.length === 0) {
      throw new Error(`local CI stage ${stageId} must define commands`);
    }
    for (const [index, command] of stage.commands.entries()) {
      const label = `local CI stage ${stageId} command ${index}`;
      if (!isPlainObject(command))
        throw new Error(`${label} must be an object`);
      requireString(command.label, `${label} label`);
      requireString(command.command, `${label} command`);
      requireStringArray(command.args, `${label} args`);
      validateWorkingDirectory(command.cwd, `${label} cwd`);
      validateEnvironment(command.env, `${label} env`);
      if (
        command.comparison !== undefined &&
        typeof command.comparison !== "boolean"
      ) {
        throw new Error(`${label} comparison must be boolean`);
      }
    }
  }

  for (const [profileId, stageIds] of Object.entries(registry.profiles)) {
    requireString(profileId, "local CI profile id");
    requireStringArray(stageIds, `local CI profile ${profileId}`);
    assertUnique(stageIds, `local CI profile ${profileId}`);
    for (const stageId of stageIds) {
      if (!Object.hasOwn(registry.stages, stageId)) {
        throw new Error(
          `local CI profile ${profileId} references unknown stage ${stageId}`,
        );
      }
    }
  }
  for (const requiredProfile of ["quick", "full"]) {
    if (!Object.hasOwn(registry.profiles, requiredProfile)) {
      throw new Error(`local CI profile ${requiredProfile} is required`);
    }
  }

  for (const [jobId, coverage] of Object.entries(registry.hostedJobs)) {
    requireString(jobId, "hosted CI job id");
    if (!isPlainObject(coverage)) {
      throw new Error(`hosted CI job ${jobId} coverage must be an object`);
    }
    const hasLocalStage = typeof coverage.localStage === "string";
    const isReleaseOnly = coverage.releaseOnly === true;
    if (hasLocalStage === isReleaseOnly) {
      throw new Error(
        `hosted CI job ${jobId} must define exactly one localStage or releaseOnly`,
      );
    }
    if (hasLocalStage) {
      if (!Object.hasOwn(registry.stages, coverage.localStage)) {
        throw new Error(
          `hosted CI job ${jobId} references unknown stage ${coverage.localStage}`,
        );
      }
      if (!registry.profiles.full.includes(coverage.localStage)) {
        throw new Error(
          `hosted CI job ${jobId} stage must be in the full profile`,
        );
      }
    } else {
      requireString(
        coverage.reason,
        `hosted CI job ${jobId} releaseOnly reason`,
      );
    }
  }

  return registry;
}

function resolveCommand(command, stage, comparison) {
  const args = [...command.args];
  if (command.comparison) {
    args.push(
      "--base",
      comparison.base,
      "--head",
      comparison.head,
      "--run",
      "--report",
      ".artifacts/local-ci/impact.json",
    );
  }
  return {
    label: command.label,
    command: command.command,
    args,
    cwd: command.cwd ?? ".",
    env: { ...(stage.env ?? {}), ...(command.env ?? {}) },
  };
}

export function buildLocalCiPlan(
  registry,
  { profile, base, head = "HEAD", from = null },
) {
  validateLocalCiRegistry(registry);
  if (!Object.hasOwn(registry.profiles, profile)) {
    throw new Error(`Unknown local CI profile: ${profile}`);
  }
  const comparison = {
    base: base ?? registry.defaultBase,
    head,
  };
  let stageIds = [...registry.profiles[profile]];
  if (from !== null) {
    const fromIndex = stageIds.indexOf(from);
    if (fromIndex === -1) {
      throw new Error(`Stage ${from} is not part of the ${profile} profile`);
    }
    stageIds = stageIds.slice(fromIndex);
  }
  const stages = stageIds.map((stageId) => {
    const stage = registry.stages[stageId];
    return {
      id: stageId,
      label: stage.label,
      commands: stage.commands.map((command) =>
        resolveCommand(command, stage, comparison),
      ),
    };
  });
  const releaseOnlyJobs =
    profile === "full"
      ? Object.entries(registry.hostedJobs)
          .filter(([, coverage]) => coverage.releaseOnly)
          .map(([id, coverage]) => ({ id, reason: coverage.reason }))
      : [];
  return {
    comparison,
    coverage: {
      completeness: from === null ? "complete" : "partial",
      fromStage: from,
    },
    profile,
    releaseOnlyJobs,
    stages,
  };
}

async function executeGit(args, { root = repoRoot } = {}) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function requireGitObjectId(value, label) {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(normalized)) {
    throw new Error(`${label} did not resolve to a Git object ID`);
  }
  return normalized;
}

export async function resolveLocalCiCandidate(
  plan,
  { root = repoRoot, git = (args) => executeGit(args, { root }) } = {},
) {
  const requestedBase = plan.comparison.base;
  const requestedHead = plan.comparison.head;
  const [
    base,
    head,
    currentHead,
    headTree,
    worktreeStatus,
    trackedDiff,
    untrackedPathsRaw,
  ] = await Promise.all([
    git(["rev-parse", "--verify", `${requestedBase}^{commit}`]),
    git(["rev-parse", "--verify", `${requestedHead}^{commit}`]),
    git(["rev-parse", "--verify", "HEAD"]),
    git(["rev-parse", "--verify", `${requestedHead}^{tree}`]),
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(["diff", "--binary", "--no-ext-diff", "HEAD", "--"]),
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untrackedPaths = untrackedPathsRaw.split("\0").filter(Boolean);
  let untrackedHashes = "";
  if (untrackedPaths.length > 0) {
    const output = await git([
      "hash-object",
      "--no-filters",
      "--",
      ...untrackedPaths,
    ]);
    const hashes = output.trimEnd().split("\n");
    if (hashes.length !== untrackedPaths.length) {
      throw new Error(
        "Git did not hash every untracked local CI candidate file",
      );
    }
    untrackedHashes = hashes
      .map((hash, index) =>
        requireGitObjectId(hash, `untracked file ${untrackedPaths[index]}`),
      )
      .join("\n");
  }
  const worktreeFingerprint = createHash("sha256")
    .update("tracked\0")
    .update(trackedDiff)
    .update("untracked-paths\0")
    .update(untrackedPathsRaw)
    .update("untracked-hashes\0")
    .update(untrackedHashes)
    .digest("hex");

  return {
    requestedBase,
    requestedHead,
    resolvedBaseSha: requireGitObjectId(base, requestedBase),
    resolvedHeadSha: requireGitObjectId(head, requestedHead),
    resolvedHeadTreeSha: requireGitObjectId(
      headTree,
      `${requestedHead}^{tree}`,
    ),
    currentHeadSha: requireGitObjectId(currentHead, "HEAD"),
    worktreeClean: worktreeStatus.length === 0,
    worktreeFingerprint,
    worktreeStatusHash: createHash("sha256")
      .update(worktreeStatus)
      .digest("hex"),
  };
}

export function validateLocalCiCandidate(plan, candidate) {
  if (candidate.resolvedHeadSha !== candidate.currentHeadSha) {
    throw new Error(
      `Local CI must execute against current HEAD (${candidate.currentHeadSha}), not ${candidate.requestedHead} (${candidate.resolvedHeadSha}).`,
    );
  }
  if (plan.profile === "full" && !candidate.worktreeClean) {
    throw new Error("The full local CI profile requires a clean worktree.");
  }
  return candidate;
}

function verifyCandidateBinding(receiptCandidate, candidate) {
  for (const field of [
    "requestedBase",
    "requestedHead",
    "resolvedBaseSha",
    "resolvedHeadSha",
    "resolvedHeadTreeSha",
    "currentHeadSha",
    "worktreeClean",
    "worktreeFingerprint",
    "worktreeStatusHash",
  ]) {
    if (receiptCandidate?.[field] !== candidate[field]) {
      throw new Error(
        `Local CI receipt does not match the current candidate: ${field}.`,
      );
    }
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(`sha256:${digest.digest("hex")}`));
  });
}

function digestJson(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function resolveArtifactEvidence(filePath, { root }) {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath.includes("\0")
  ) {
    throw new Error(
      "local CI artifact path must be a non-empty string without NUL bytes",
    );
  }
  const requestedPath = path.resolve(root, filePath);
  const realPath = await realpath(requestedPath);
  const metadata = await stat(realPath);
  if (!metadata.isFile()) {
    throw new Error(
      `local CI artifact is not a regular file: ${requestedPath}`,
    );
  }
  return {
    path: relativePath(root, requestedPath),
    realPath,
    sha256: await hashFile(realPath),
  };
}

async function collectArtifactFiles(directory, { root }) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectArtifactFiles(entryPath, { root })));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(await resolveArtifactEvidence(entryPath, { root }));
    }
  }
  return files;
}

function resolveProductJourneyArtifactDirectory(
  plan,
  { root = repoRoot } = {},
) {
  const stage = plan.stages.find(
    (candidate) => candidate.id === "electron-product-journeys",
  );
  const configured = stage?.commands
    .map((command) => command.env?.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR)
    .find((value) => value !== undefined && value !== "");
  return path.resolve(root, configured ?? PRODUCT_JOURNEY_ARTIFACT_DIR);
}

function assertStringArrayEqual(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error(`${label} must match the canonical product journey IDs`);
  }
}

function assertPassedProductJourneyResult(report) {
  if (
    !isPlainObject(report) ||
    report.version !== PRODUCT_JOURNEY_RESULTS_VERSION
  ) {
    throw new Error("product journey results version 4 is required");
  }
  if (report.status !== "passed") {
    throw new Error("product journey results must have passed status");
  }
  if (report.catalogDigest !== PRODUCT_JOURNEY_CATALOG_DIGEST) {
    throw new Error("product journey results catalog digest is not canonical");
  }
  const expectedIds = PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id);
  assertStringArrayEqual(
    report.catalogJourneyIds,
    expectedIds,
    "product journey result catalog",
  );
  assertStringArrayEqual(
    report.journeyIds,
    expectedIds,
    "product journey results",
  );
  if (report.allPassed !== true || report.allClean !== true) {
    throw new Error(
      "product journey results must record allPassed and allClean",
    );
  }
  if (
    !Array.isArray(report.journeys) ||
    report.journeys.length !== expectedIds.length ||
    report.journeys.some(
      (journey, index) =>
        journey?.id !== expectedIds[index] ||
        journey.status !== "passed" ||
        journey.cleanPass !== true,
    )
  ) {
    throw new Error(
      "product journey results must contain all passed clean journeys",
    );
  }
  return expectedIds;
}

function assertPassedProductJourneyManifest(manifest, expectedIds) {
  if (!isPlainObject(manifest) || manifest.version !== 1) {
    throw new Error("product journey audit manifest version 1 is required");
  }
  if (
    manifest.status !== "passed" ||
    manifest.catalogDigest !== PRODUCT_JOURNEY_CATALOG_DIGEST ||
    manifest.allPassed !== true ||
    manifest.allClean !== true
  ) {
    throw new Error(
      "product journey audit manifest is not a clean Full result",
    );
  }
  assertStringArrayEqual(
    manifest.journeyIds,
    expectedIds,
    "product journey manifest",
  );
  if (!isPlainObject(manifest.results) || !Array.isArray(manifest.artifacts)) {
    throw new Error(
      "product journey audit manifest is missing artifact entries",
    );
  }
  const artifactNames = manifest.artifacts.map((artifact, index) => {
    assertArtifactIdentity(
      artifact,
      `product journey manifest entry ${index}`,
      { requireRequestedPath: true },
    );
    if (typeof artifact.name !== "string" || artifact.name.length === 0) {
      throw new Error(
        `product journey manifest entry ${index} must name its build artifact`,
      );
    }
    return artifact.name;
  });
  if (
    JSON.stringify([...artifactNames].sort()) !==
    JSON.stringify([...PRODUCT_JOURNEY_BUILD_ARTIFACT_NAMES].sort())
  ) {
    throw new Error(
      "product journey audit manifest must declare exactly the canonical build artifacts",
    );
  }
}

function assertArtifactIdentity(
  identity,
  label,
  { requireRequestedPath = false } = {},
) {
  if (
    !isPlainObject(identity) ||
    typeof identity.path !== "string" ||
    typeof identity.realPath !== "string" ||
    identity.path.length === 0 ||
    identity.realPath.length === 0 ||
    identity.path.includes("\0") ||
    identity.realPath.includes("\0") ||
    !/^sha256:[0-9a-f]{64}$/u.test(identity.sha256 ?? "")
  ) {
    throw new Error(`${label} artifact identity is invalid`);
  }
  if (
    requireRequestedPath &&
    (typeof identity.requestedPath !== "string" ||
      identity.requestedPath.length === 0 ||
      identity.requestedPath.includes("\0"))
  ) {
    throw new Error(`${label} artifact requested path is invalid`);
  }
}

/** Collect and validate the immutable product-journey evidence for a Full receipt. */
export async function collectProductJourneyEvidence(
  plan,
  { root = repoRoot } = {},
) {
  const artifactRoot = resolveProductJourneyArtifactDirectory(plan, { root });
  const resultsPath = path.join(artifactRoot, "results.json");
  const manifestPath = path.join(artifactRoot, "manifest.json");
  const files = await collectArtifactFiles(artifactRoot, { root });
  const resultEvidence = files.find(
    (entry) => entry.path === relativePath(root, resultsPath),
  );
  const manifestEvidence = files.find(
    (entry) => entry.path === relativePath(root, manifestPath),
  );
  if (!resultEvidence || !manifestEvidence) {
    throw new Error(
      "Full product journey artifacts must include results.json and manifest.json",
    );
  }

  const report = JSON.parse(await readFile(resultsPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const journeyIds = assertPassedProductJourneyResult(report);
  assertPassedProductJourneyManifest(manifest, journeyIds);
  if (
    manifest.results.path !== "results.json" ||
    manifest.results.realPath !== resultEvidence.realPath ||
    manifest.results.sha256 !== resultEvidence.sha256
  ) {
    throw new Error(
      "product journey audit manifest does not bind results.json",
    );
  }

  const buildArtifacts = [];
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const label = `product journey manifest entry ${index}`;
    assertArtifactIdentity(artifact, label, { requireRequestedPath: true });
    const currentPath = await resolveArtifactEvidence(artifact.path, { root });
    const currentRequestedPath = await resolveArtifactEvidence(
      artifact.requestedPath,
      { root },
    );
    if (
      currentPath.realPath !== currentRequestedPath.realPath ||
      currentPath.sha256 !== currentRequestedPath.sha256 ||
      currentPath.realPath !== artifact.realPath ||
      currentRequestedPath.realPath !== artifact.realPath ||
      currentPath.sha256 !== artifact.sha256 ||
      currentRequestedPath.sha256 !== artifact.sha256
    ) {
      throw new Error(
        `product journey manifest artifact ${artifact.name ?? artifact.path} changed after preflight`,
      );
    }
    buildArtifacts.push(currentPath);
  }
  const artifacts = [...files, ...buildArtifacts].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  return {
    catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
    journeyIds,
    allPassed: true,
    allClean: true,
    results: resultEvidence,
    manifest: manifestEvidence,
    artifacts,
    artifactDigest: digestJson(artifacts),
  };
}

function verifyProductJourneyEvidence(receiptEvidence, currentEvidence) {
  if (!isPlainObject(receiptEvidence)) {
    throw new Error("Full receipt product journey evidence is required.");
  }
  if (receiptEvidence.catalogDigest !== PRODUCT_JOURNEY_CATALOG_DIGEST) {
    throw new Error(
      "Full receipt product journey catalog digest is not canonical.",
    );
  }
  const expectedIds = PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id);
  assertStringArrayEqual(
    receiptEvidence.journeyIds,
    expectedIds,
    "Full receipt product journey evidence",
  );
  if (receiptEvidence.allPassed !== true || receiptEvidence.allClean !== true) {
    throw new Error(
      "Full receipt product journey evidence must be passed and clean.",
    );
  }
  for (const field of ["results", "manifest"]) {
    assertArtifactIdentity(
      receiptEvidence[field],
      `Full receipt product journey ${field}`,
    );
  }
  if (
    !Array.isArray(receiptEvidence.artifacts) ||
    !/^sha256:[0-9a-f]{64}$/u.test(receiptEvidence.artifactDigest ?? "")
  ) {
    throw new Error(
      "Full receipt product journey artifact evidence is invalid.",
    );
  }
  for (const [index, artifact] of receiptEvidence.artifacts.entries()) {
    assertArtifactIdentity(
      artifact,
      `Full receipt product journey artifact ${index}`,
    );
  }
  if (currentEvidence) {
    for (const field of [
      "catalogDigest",
      "journeyIds",
      "allPassed",
      "allClean",
      "artifactDigest",
    ]) {
      if (
        JSON.stringify(receiptEvidence[field]) !==
        JSON.stringify(currentEvidence[field])
      ) {
        throw new Error(
          `Full receipt product journey evidence does not match current artifacts: ${field}.`,
        );
      }
    }
    for (const field of ["results", "manifest", "artifacts"]) {
      if (
        JSON.stringify(receiptEvidence[field]) !==
        JSON.stringify(currentEvidence[field])
      ) {
        throw new Error(
          `Full receipt product journey evidence does not match current artifacts: ${field}.`,
        );
      }
    }
  }
}

export function verifyLocalCiReceipt(
  receipt,
  { profile, candidate, currentProductJourneyEvidence = null },
) {
  if (!isPlainObject(receipt) || receipt.version !== LOCAL_CI_RECEIPT_VERSION) {
    throw new Error(
      `Local CI receipt version ${LOCAL_CI_RECEIPT_VERSION} is required.`,
    );
  }
  if (receipt.profile !== profile || receipt.status !== "passed") {
    throw new Error(`A passed ${profile} local CI receipt is required.`);
  }
  if (
    receipt.coverage?.completeness !== "complete" ||
    receipt.coverage?.fromStage !== null
  ) {
    throw new Error(
      "A complete local CI receipt from the first stage is required.",
    );
  }
  if (profile === "full" && receipt.candidate?.worktreeClean !== true) {
    throw new Error("A clean-worktree Full local CI receipt is required.");
  }
  verifyCandidateBinding(receipt.candidate, candidate);
  if (profile === "full") {
    verifyProductJourneyEvidence(
      receipt.productJourneyEvidence,
      currentProductJourneyEvidence,
    );
  }
  return receipt;
}

function readOptionValue(argv, option, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseLocalCiArgs(argv) {
  const result = {
    base: null,
    dryRun: false,
    from: null,
    head: null,
    list: false,
    profile: null,
    report: null,
    verify: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--list") result.list = true;
    else if (argument === "--verify") result.verify = true;
    else if (argument === "--base") {
      result.base = readOptionValue(argv, argument, index);
      index += 1;
    } else if (argument === "--head") {
      result.head = readOptionValue(argv, argument, index);
      index += 1;
    } else if (argument === "--from") {
      result.from = readOptionValue(argv, argument, index);
      index += 1;
    } else if (argument === "--report") {
      result.report = readOptionValue(argv, argument, index);
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else if (result.profile === null) result.profile = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return result;
}

function executeCommand(entry, { root = repoRoot } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const executable =
      process.platform === "win32" && entry.command === "pnpm"
        ? "pnpm.cmd"
        : entry.command;
    const child = spawn(executable, entry.args, {
      cwd: path.resolve(root, entry.cwd),
      env: { ...process.env, ...entry.env },
      shell: false,
      stdio: "inherit",
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({
        durationMs: Math.round(performance.now() - started),
        ...result,
      });
    };
    child.once("error", (error) =>
      finish({ error: error.message, exitCode: null, signal: null }),
    );
    child.once("exit", (exitCode, signal) =>
      finish({ exitCode, signal: signal ?? null }),
    );
  });
}

function notRunCommand(command, reason) {
  return {
    ...command,
    durationMs: 0,
    exitCode: null,
    reason,
    signal: null,
    status: "not-run",
  };
}

export async function runLocalCiPlan(
  plan,
  {
    candidate = null,
    dryRun = false,
    executeCommand: execute = (entry) => executeCommand(entry),
    notify = () => {},
    productJourneyEvidence = null,
  } = {},
) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const stages = [];
  let failedStage = null;

  for (const stage of plan.stages) {
    if (failedStage) {
      stages.push({
        id: stage.id,
        label: stage.label,
        status: "not-run",
        durationMs: 0,
        commands: stage.commands.map((command) =>
          notRunCommand(command, `Fail-fast after ${failedStage}.`),
        ),
      });
      continue;
    }
    notify({ stage, type: "stage-start" });
    if (dryRun) {
      for (const command of stage.commands) {
        notify({ command, stage, type: "command-start" });
      }
      stages.push({
        id: stage.id,
        label: stage.label,
        status: "planned",
        durationMs: 0,
        commands: stage.commands.map((command) => ({
          ...command,
          durationMs: 0,
          exitCode: null,
          signal: null,
          status: "planned",
        })),
      });
      continue;
    }

    const stageStarted = performance.now();
    const commands = [];
    let failedCommand = null;
    for (const command of stage.commands) {
      if (failedCommand) {
        commands.push(
          notRunCommand(command, `Fail-fast after ${failedCommand}.`),
        );
        continue;
      }
      notify({ command, stage, type: "command-start" });
      let execution;
      try {
        execution = await execute(command);
      } catch (error) {
        execution = {
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
          exitCode: null,
          signal: null,
        };
      }
      const status = execution.exitCode === 0 ? "passed" : "failed";
      commands.push({ ...command, ...execution, status });
      notify({ command, execution, stage, status, type: "command-end" });
      if (status === "failed") failedCommand = command.label;
    }
    const status = failedCommand ? "failed" : "passed";
    stages.push({
      id: stage.id,
      label: stage.label,
      status,
      durationMs: Math.round(performance.now() - stageStarted),
      commands,
    });
    notify({ stage, status, type: "stage-end" });
    if (status === "failed") failedStage = stage.id;
  }

  return {
    version: LOCAL_CI_RECEIPT_VERSION,
    profile: plan.profile,
    comparison: plan.comparison,
    coverage: plan.coverage,
    candidate,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    status: dryRun ? "planned" : failedStage ? "failed" : "passed",
    productJourneyEvidence,
    releaseOnlyJobs: plan.releaseOnlyJobs,
    stages,
  };
}

export async function prepareLocalCiArtifacts(plan, { root = repoRoot } = {}) {
  const directories = new Set([path.join(root, ".artifacts", "local-ci")]);
  for (const stage of plan.stages) {
    for (const command of stage.commands) {
      for (let index = 0; index < command.args.length - 1; index += 1) {
        if (!["--output", "--report"].includes(command.args[index])) continue;
        directories.add(
          path.dirname(
            path.resolve(root, command.cwd, command.args[index + 1]),
          ),
        );
      }
    }
  }
  await Promise.all(
    [...directories].map((directory) => mkdir(directory, { recursive: true })),
  );
}

function quoteArgument(value) {
  return /^[A-Za-z0-9_./:@=,+-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatCommand(command) {
  return [command.command, ...command.args].map(quoteArgument).join(" ");
}

function printRegistry(registry) {
  process.stdout.write("Local CI profiles:\n");
  for (const [profile, stageIds] of Object.entries(registry.profiles)) {
    process.stdout.write(`- ${profile}: ${stageIds.join(", ")}\n`);
  }
  const releaseOnly = Object.entries(registry.hostedJobs).filter(
    ([, coverage]) => coverage.releaseOnly,
  );
  if (releaseOnly.length > 0) {
    process.stdout.write("Release-only hosted coverage:\n");
    for (const [jobId, coverage] of releaseOnly) {
      process.stdout.write(`- ${jobId}: ${coverage.reason}\n`);
    }
  }
}

async function writeReport(reportPath, result) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const args = parseLocalCiArgs(process.argv.slice(2));
  const registry = validateLocalCiRegistry(
    JSON.parse(await readFile(registryPath, "utf8")),
  );
  if (args.list) {
    printRegistry(registry);
    return;
  }
  if (args.profile === null) {
    throw new Error("Usage: local-ci.mjs <quick|full> [options]");
  }
  const plan = buildLocalCiPlan(registry, {
    profile: args.profile,
    base: args.base ?? registry.defaultBase,
    head: args.head ?? "HEAD",
    from: args.from,
  });
  process.stdout.write(
    `[local-ci] profile=${plan.profile} base=${plan.comparison.base} head=${plan.comparison.head}\n`,
  );
  for (const job of plan.releaseOnlyJobs) {
    process.stdout.write(`[local-ci] release-only ${job.id}: ${job.reason}\n`);
  }
  let candidate = null;
  if (!args.dryRun) {
    candidate = validateLocalCiCandidate(
      plan,
      await resolveLocalCiCandidate(plan),
    );
  }
  const reportPath = path.resolve(
    repoRoot,
    args.report ?? `.artifacts/local-ci/${plan.profile}.json`,
  );
  if (args.verify) {
    if (args.dryRun) {
      throw new Error("--verify cannot be combined with --dry-run");
    }
    const receipt = JSON.parse(await readFile(reportPath, "utf8"));
    const currentProductJourneyEvidence =
      plan.profile === "full"
        ? await collectProductJourneyEvidence(plan)
        : null;
    verifyLocalCiReceipt(receipt, {
      profile: plan.profile,
      candidate,
      currentProductJourneyEvidence,
    });
    process.stdout.write(`[local-ci] verified=${reportPath}\n`);
    return;
  }
  if (!args.dryRun) await prepareLocalCiArtifacts(plan);
  const result = await runLocalCiPlan(plan, {
    candidate,
    dryRun: args.dryRun,
    notify(event) {
      if (event.type === "stage-start") {
        process.stdout.write(
          `\n[local-ci] ${event.stage.id}: ${event.stage.label}\n`,
        );
      } else if (event.type === "command-start") {
        process.stdout.write(`[local-ci] $ ${formatCommand(event.command)}\n`);
      } else if (event.type === "command-end") {
        process.stdout.write(
          `[local-ci] ${event.status.toUpperCase()} ${event.command.label}\n`,
        );
      }
    },
  });
  if (!args.dryRun) {
    const finishedCandidate = validateLocalCiCandidate(
      plan,
      await resolveLocalCiCandidate(plan),
    );
    try {
      verifyCandidateBinding(result.candidate, finishedCandidate);
      if (plan.profile === "full" && result.status === "passed") {
        result.productJourneyEvidence =
          await collectProductJourneyEvidence(plan);
        verifyLocalCiReceipt(result, {
          profile: plan.profile,
          candidate: finishedCandidate,
          currentProductJourneyEvidence: result.productJourneyEvidence,
        });
      }
    } catch (error) {
      result.status = "failed";
      result.receiptError =
        error instanceof Error ? error.message : String(error);
    }
    await writeReport(reportPath, result);
    process.stdout.write(`[local-ci] report=${reportPath}\n`);
  }
  process.stdout.write(`[local-ci] status=${result.status}\n`);
  if (result.status === "failed") process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `[local-ci] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
