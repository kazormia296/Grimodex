#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  digestProductJourneyCatalog,
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import {
  assertBuildArtifacts,
  assertProductJourneyArtifactEvidence,
} from "../electron/scripts/product-journeys.mjs";
import {
  assertC2ZcFixtureCandidateBinding,
  C2ZC_PRODUCT_JOURNEY_ID,
  assertC2ZcRestoreFixtureManifest,
  loadC2ZcRestoreFixtureInput,
} from "../electron/scripts/c2zc-canonical-product-journey.mjs";
import {
  C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
  C2ZC_RUST_ACCEPTANCE_GATE_IDS,
  C2ZC_RUST_ACCEPTANCE_RECEIPT_PATH,
  verifyC2ZcRustAcceptanceReceipt,
} from "./c2zc-rust-acceptance-receipt.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const registryPath = path.join(repoRoot, "scripts/local-ci-registry.json");
const execFileAsync = promisify(execFile);
const LOCAL_CI_RECEIPT_VERSION = 3;
const PRODUCT_JOURNEY_RESULTS_VERSION = 5;
const PRODUCT_JOURNEY_ARTIFACT_DIR = ".artifacts/product-journeys";
const C2ZC_RUST_ACCEPTANCE_GATE_STAGE = "c2-zc-rust-acceptance-gate";
const C2ZC_RESTORE_FIXTURE_STAGE = "c2-zc-restore-fixture-builder";
const C2ZC_RESTORE_FIXTURE_ENV = "GRIMODEX_C2ZC_RESTORE_FIXTURE";
const C2ZC_RESTORE_FIXTURE_OUTPUT_PLACEHOLDER =
  "__C2ZC_RESTORE_FIXTURE_OUTPUT_DIR__";
const C2ZC_RESTORE_FIXTURE_MANIFEST_PLACEHOLDER =
  "__C2ZC_RESTORE_FIXTURE_MANIFEST__";
const C2ZC_RESTORE_FIXTURE_BACKUP_NAME = "c2zc-restore-fixture.backup.db";
const C2ZC_RESTORE_FIXTURE_DATABASE_NAME = "c2zc-restore-fixture.db";
const C2ZC_RESTORE_FIXTURE_MANIFEST_NAME = "c2zc-restore-fixture.manifest.json";
const C2ZC_RUST_REQUESTED_BASE_ENV = "GRIMODEX_C2ZC_RUST_REQUESTED_BASE";
const C2ZC_RUST_REQUESTED_HEAD_ENV = "GRIMODEX_C2ZC_RUST_REQUESTED_HEAD";
const C2ZC_RUST_CANDIDATE_JSON_ENV = "GRIMODEX_C2ZC_RUST_CANDIDATE_JSON";
const C2ZC_RUST_RECEIPT_PATH_ENV = "GRIMODEX_C2ZC_RUST_RECEIPT_PATH";
const PRODUCT_JOURNEY_BUILD_RECEIPT_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_BUILD_RECEIPT";
const PRODUCT_JOURNEY_BUILD_RECEIPT_KEYS = [
  "version",
  "verified",
  "source",
  "candidate",
  "artifacts",
];
const PRODUCT_JOURNEY_BUILD_ARTIFACT_KEYS = [
  "name",
  "path",
  "requestedPath",
  "realPath",
  "size",
  "sha256",
];
const PRODUCT_JOURNEY_CATALOGS = [
  PRODUCT_JOURNEY_CATALOG,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
];
const PRODUCT_JOURNEY_CANDIDATE_KEYS = [
  "requestedBase",
  "requestedHead",
  "resolvedBaseSha",
  "resolvedHeadSha",
  "resolvedHeadTreeSha",
  "currentHeadSha",
  "worktreeClean",
  "worktreeFingerprint",
  "worktreeStatusHash",
];

function buildArtifactNamesForJourneyIds(
  journeyIds,
  catalog = PRODUCT_JOURNEY_CATALOG,
) {
  const selectedIds = new Set(journeyIds);
  const capabilities = new Set(
    catalog
      .filter((journey) => selectedIds.has(journey.id))
      .flatMap((journey) => journey.capabilities ?? []),
  );
  const names = [];
  if (capabilities.has("electron")) {
    names.push("Electron main", "renderer");
  }
  if (capabilities.has("napi")) names.push("N-API native module");
  if (capabilities.has("mcp")) names.push("MCP sidecar");
  return names;
}

function productJourneyCatalogForDigest(catalogDigest) {
  return PRODUCT_JOURNEY_CATALOGS.find(
    (catalog) => digestProductJourneyCatalog(catalog) === catalogDigest,
  );
}

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

function validateC2ZcRestoreFixtureStage(stage) {
  const label = `local CI stage ${C2ZC_RESTORE_FIXTURE_STAGE}`;
  const operations = stage.commands.map(fixtureCommandOperation);
  if (
    operations.length !== 2 ||
    operations.filter((operation) => operation === "build").length !== 1 ||
    operations.filter((operation) => operation === "verify").length !== 1
  ) {
    throw new Error(
      `${label} must define exactly one build and one verify command`,
    );
  }
  for (const [index, command] of stage.commands.entries()) {
    const commandLabel = `${label} command ${index}`;
    const manifestPathIndex = command.args.indexOf("--manifest-path");
    if (
      manifestPathIndex === -1 ||
      command.args[manifestPathIndex + 1] !== "src-tauri/Cargo.toml"
    ) {
      throw new Error(
        `${commandLabel} must pin --manifest-path src-tauri/Cargo.toml`,
      );
    }
    for (const option of ["--repo-root", "--candidate"]) {
      if (!command.args.includes(option)) {
        throw new Error(`${commandLabel} must include ${option}`);
      }
    }
    const operation = operations[index];
    const requiredOptions =
      operation === "build"
        ? ["--output-dir", "--expected-head", "--expected-tree"]
        : ["--manifest"];
    for (const option of requiredOptions) {
      if (!command.args.includes(option)) {
        throw new Error(
          `${commandLabel} ${operation} command is missing ${option}`,
        );
      }
    }
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
    if (stageId === C2ZC_RESTORE_FIXTURE_STAGE) {
      validateC2ZcRestoreFixtureStage(stage);
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
    size: metadata.size,
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

function resolveC2ZcRustAcceptanceReceiptPath(plan, { root = repoRoot } = {}) {
  const stage = plan.stages.find(
    (candidate) => candidate.id === "electron-product-journeys",
  );
  const configured = stage?.commands
    .map((command) => command.env?.[C2ZC_RUST_RECEIPT_PATH_ENV])
    .find((value) => value !== undefined && value !== "");
  return path.resolve(root, configured ?? C2ZC_RUST_ACCEPTANCE_RECEIPT_PATH);
}

function fixtureCommandOperation(command) {
  if (command.args?.includes("build")) return "build";
  if (command.args?.includes("verify")) return "verify";
  return null;
}

function assertOutsideRepository(root, candidatePath, label) {
  const relative = path.relative(
    path.resolve(root),
    path.resolve(candidatePath),
  );
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be outside the candidate repository`);
  }
}

async function createC2ZcRestoreFixtureContext(root, plan, candidate) {
  if (!candidate) {
    throw new Error(
      "C2-ZC restore fixture builder requires a resolved candidate binding",
    );
  }
  const outputDir = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-c2zc-restore-fixture-"),
  );
  try {
    assertOutsideRepository(root, outputDir, "C2-ZC restore fixture output");
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
  return {
    outputDir,
    fixturePath: path.join(outputDir, C2ZC_RESTORE_FIXTURE_BACKUP_NAME),
    databasePath: path.join(outputDir, C2ZC_RESTORE_FIXTURE_DATABASE_NAME),
    manifestPath: path.join(outputDir, C2ZC_RESTORE_FIXTURE_MANIFEST_NAME),
    candidate,
    plan,
    input: null,
    evidence: null,
  };
}

function replaceCommandArgument(args, option, value, label) {
  const index = args.indexOf(option);
  if (index === -1 || index === args.length - 1) {
    throw new Error(`${label} is missing ${option}`);
  }
  const replaced = [...args];
  replaced[index + 1] = value;
  return replaced;
}

async function bindC2ZcRestoreFixtureCommand(
  command,
  stageId,
  { root, plan, candidate, context = null } = {},
) {
  if (stageId !== C2ZC_RESTORE_FIXTURE_STAGE) {
    return { command, context };
  }
  const operation = fixtureCommandOperation(command);
  if (!operation) {
    throw new Error(
      "C2-ZC restore fixture stage must declare build and verify commands",
    );
  }
  const nextContext =
    context ?? (await createC2ZcRestoreFixtureContext(root, plan, candidate));
  let args = [...command.args];
  args = replaceCommandArgument(
    args,
    "--repo-root",
    path.resolve(root),
    "C2-ZC restore fixture command",
  );
  args = replaceCommandArgument(
    args,
    "--candidate",
    plan.comparison.head,
    "C2-ZC restore fixture command",
  );
  if (operation === "build") {
    args = replaceCommandArgument(
      args,
      "--output-dir",
      nextContext.outputDir,
      "C2-ZC restore fixture build command",
    );
    args = replaceCommandArgument(
      args,
      "--expected-head",
      candidate.resolvedHeadSha,
      "C2-ZC restore fixture build command",
    );
    args = replaceCommandArgument(
      args,
      "--expected-tree",
      candidate.resolvedHeadTreeSha,
      "C2-ZC restore fixture build command",
    );
  } else {
    args = replaceCommandArgument(
      args,
      "--manifest",
      nextContext.manifestPath,
      "C2-ZC restore fixture verify command",
    );
  }
  return { command: { ...command, args }, context: nextContext };
}

async function captureC2ZcRestoreFixtureEvidence(context, root) {
  if (!context?.input?.manifestPath) {
    throw new Error("C2-ZC restore fixture was not loaded after verification");
  }
  const evidenceDirectory = path.join(
    root,
    ".artifacts",
    "local-ci",
    "c2-zc-restore-fixture",
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const fixtureEvidencePath = path.join(
    evidenceDirectory,
    C2ZC_RESTORE_FIXTURE_BACKUP_NAME,
  );
  const databaseEvidencePath = path.join(
    evidenceDirectory,
    C2ZC_RESTORE_FIXTURE_DATABASE_NAME,
  );
  const manifestEvidencePath = path.join(
    evidenceDirectory,
    C2ZC_RESTORE_FIXTURE_MANIFEST_NAME,
  );
  await copyFile(context.fixturePath, fixtureEvidencePath);
  await copyFile(context.databasePath, databaseEvidencePath);
  await copyFile(context.manifestPath, manifestEvidencePath);
  const verifiedCopy = await loadC2ZcRestoreFixtureInput({
    path: fixtureEvidencePath,
    manifest: manifestEvidencePath,
  });
  assertC2ZcFixtureCandidateBinding(
    verifiedCopy.manifest.candidate,
    context.candidate,
    "C2-ZC copied restore fixture candidate",
  );
  const [fixture, database, manifest] = await Promise.all([
    resolveArtifactEvidence(fixtureEvidencePath, { root }),
    resolveArtifactEvidence(databaseEvidencePath, { root }),
    resolveArtifactEvidence(manifestEvidencePath, { root }),
  ]);
  return {
    path: fixture.path,
    manifestPath: manifest.path,
    manifest,
    artifacts: { fixture, database },
    fixtureManifest: verifiedCopy.manifest,
    manifestVersion: verifiedCopy.manifest.manifestVersion,
    fixtureSha256: verifiedCopy.manifest.fixtureSha256,
    fixtureSizeBytes: verifiedCopy.manifest.fixtureSizeBytes,
    candidate: verifiedCopy.manifest.candidate,
  };
}

async function validateC2ZcRestoreFixtureContext(context) {
  const input = await loadC2ZcRestoreFixtureInput({
    path: context.fixturePath,
    manifest: context.manifestPath,
  });
  assertC2ZcFixtureCandidateBinding(
    input.manifest.candidate,
    context.candidate,
    "C2-ZC restore fixture candidate",
  );
  context.input = input;
  return input;
}

function reportRequiresC2ZcRustAcceptance(report) {
  return report?.acceptanceRequired === true;
}

function assertC2ZcRustAcceptanceEvidenceShape(evidence, label) {
  if (
    !isPlainObject(evidence) ||
    evidence.verified !== true ||
    typeof evidence.receiptPath !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(evidence.receiptSha256 ?? "") ||
    !isPlainObject(evidence.candidate) ||
    !isPlainObject(evidence.receipt) ||
    evidence.receipt.schema !== "grimodex.c2zc.rust-acceptance-receipt" ||
    evidence.receipt.version !== 1 ||
    !Array.isArray(evidence.gates) ||
    JSON.stringify(evidence.gates.map((gate) => gate?.id)) !==
      JSON.stringify(C2ZC_RUST_ACCEPTANCE_GATE_IDS) ||
    JSON.stringify(evidence.gates) !== JSON.stringify(evidence.receipt.gates) ||
    JSON.stringify(evidence.candidate) !==
      JSON.stringify(evidence.receipt.candidate)
  ) {
    throw new Error(`${label} must include all ordered Rust acceptance gates`);
  }
}

function assertProductJourneyBuildReceiptShape(
  evidence,
  label,
  { candidate = null, artifactNames = null } = {},
) {
  if (
    !isPlainObject(evidence) ||
    JSON.stringify(Object.keys(evidence).sort()) !==
      JSON.stringify([...PRODUCT_JOURNEY_BUILD_RECEIPT_KEYS].sort()) ||
    evidence.version !== 1 ||
    evidence.verified !== true ||
    evidence.source !== "local-ci-candidate" ||
    !isPlainObject(evidence.candidate) ||
    JSON.stringify(Object.keys(evidence.candidate).sort()) !==
      JSON.stringify([...PRODUCT_JOURNEY_CANDIDATE_KEYS].sort()) ||
    typeof evidence.candidate.requestedBase !== "string" ||
    evidence.candidate.requestedBase.length === 0 ||
    evidence.candidate.requestedBase.includes("\0") ||
    typeof evidence.candidate.requestedHead !== "string" ||
    evidence.candidate.requestedHead.length === 0 ||
    evidence.candidate.requestedHead.includes("\0") ||
    !/^[0-9a-f]{40,64}$/u.test(evidence.candidate.resolvedBaseSha ?? "") ||
    !/^[0-9a-f]{40,64}$/u.test(evidence.candidate.resolvedHeadSha ?? "") ||
    !/^[0-9a-f]{40,64}$/u.test(evidence.candidate.resolvedHeadTreeSha ?? "") ||
    !/^[0-9a-f]{40,64}$/u.test(evidence.candidate.currentHeadSha ?? "") ||
    typeof evidence.candidate.worktreeClean !== "boolean" ||
    !/^[0-9a-f]{64}$/u.test(evidence.candidate.worktreeFingerprint ?? "") ||
    !/^[0-9a-f]{64}$/u.test(evidence.candidate.worktreeStatusHash ?? "")
  ) {
    throw new Error(`${label} must include a verified local-CI build receipt`);
  }
  if (candidate) {
    for (const field of PRODUCT_JOURNEY_CANDIDATE_KEYS) {
      if (evidence.candidate[field] !== candidate[field]) {
        throw new Error(
          `${label} build receipt is bound to a different candidate: ${field}`,
        );
      }
    }
  }
  if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length === 0) {
    throw new Error(`${label} must include exact build artifact identities`);
  }
  const artifactNamesInReceipt = evidence.artifacts.map(
    (artifact) => artifact?.name,
  );
  if (new Set(artifactNamesInReceipt).size !== artifactNamesInReceipt.length) {
    throw new Error(`${label} build artifact names must be unique`);
  }
  if (artifactNames !== null) {
    const actualNames = evidence.artifacts.map((artifact) => artifact?.name);
    if (
      JSON.stringify(actualNames) !== JSON.stringify(artifactNames) ||
      new Set(actualNames).size !== actualNames.length
    ) {
      throw new Error(
        `${label} build artifact names/set do not match selection`,
      );
    }
    for (const [index, artifact] of evidence.artifacts.entries()) {
      assertBuildArtifactIdentity(artifact, `${label} build artifact ${index}`);
    }
  } else {
    for (const [index, artifact] of evidence.artifacts.entries()) {
      assertBuildArtifactIdentity(artifact, `${label} build artifact ${index}`);
    }
  }
  return evidence;
}

function assertStringArrayEqual(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error(`${label} must match the canonical product journey IDs`);
  }
}

function requiredProductJourneyIds(catalog, report = null) {
  const fromCatalog = catalog
    .filter(
      (journey) =>
        journey.required !== false && journey.acceptanceRole !== "diagnostic",
    )
    .map((journey) => journey.id);
  if (Array.isArray(report?.requiredJourneyIds)) {
    assertStringArrayEqual(
      report.requiredJourneyIds,
      fromCatalog,
      "product journey required IDs",
    );
  }
  return fromCatalog;
}

function assertPassedProductJourneyResult(
  report,
  {
    catalog = PRODUCT_JOURNEY_CATALOG,
    expectedArtifactNames = null,
    expectedArtifacts = null,
  } = {},
) {
  if (
    !isPlainObject(report) ||
    report.version !== PRODUCT_JOURNEY_RESULTS_VERSION
  ) {
    throw new Error("product journey results version 5 is required");
  }
  if (report.status !== "passed") {
    throw new Error("product journey results must have passed status");
  }
  if (report.catalogDigest !== digestProductJourneyCatalog(catalog)) {
    throw new Error("product journey results catalog digest is not selected");
  }
  const expectedIds = catalog.map((journey) => journey.id);
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
  const requiredIds = requiredProductJourneyIds(catalog, report);
  if (report.allPassed !== true || report.allClean !== true) {
    throw new Error(
      "product journey results must record allPassed and allClean",
    );
  }
  if (report.rustAcceptanceComplete !== true) {
    throw new Error(
      "product journey results must record a completed Rust acceptance gate",
    );
  }
  if (report.acceptanceRequired === true) {
    assertProductJourneyBuildReceiptShape(
      report.buildReceipt,
      "C2-ZC product journey results",
      {
        artifactNames:
          expectedArtifactNames ??
          buildArtifactNamesForJourneyIds(report.journeyIds),
      },
    );
    if (expectedArtifacts) {
      assertProductJourneyArtifactEvidence(
        report.buildReceipt.artifacts,
        expectedArtifacts,
        "C2-ZC product journey results build artifacts",
      );
    }
  }
  if (
    report.acceptanceRequired === true &&
    (report.acceptanceComplete !== true ||
      !isPlainObject(report.c2zcRustAcceptance))
  ) {
    throw new Error(
      "C2-ZC product journey results must include complete Rust acceptance evidence",
    );
  }
  if (report.acceptanceRequired === true) {
    assertC2ZcRustAcceptanceEvidenceShape(
      report.c2zcRustAcceptance,
      "C2-ZC product journey results",
    );
  }
  if (
    !Array.isArray(report.journeys) ||
    report.journeys.length !== expectedIds.length ||
    report.journeys.some(
      (journey, index) => journey?.id !== expectedIds[index],
    ) ||
    report.journeys.some(
      (journey) =>
        requiredIds.includes(journey?.id) &&
        (journey.status !== "passed" || journey.cleanPass !== true),
    )
  ) {
    throw new Error(
      "product journey results must contain all required passed clean journeys",
    );
  }
  return expectedIds;
}

function assertPassedProductJourneyManifest(
  manifest,
  expectedIds,
  report = null,
  {
    candidate = null,
    catalog = PRODUCT_JOURNEY_CATALOG,
    expectedArtifacts = null,
  } = {},
) {
  if (!isPlainObject(manifest) || manifest.version !== 1) {
    throw new Error("product journey audit manifest version 1 is required");
  }
  if (
    manifest.status !== "passed" ||
    manifest.catalogDigest !== digestProductJourneyCatalog(catalog) ||
    manifest.allPassed !== true ||
    manifest.allClean !== true ||
    manifest.rustAcceptanceComplete !== true
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
  if (report) {
    assertStringArrayEqual(
      manifest.requiredJourneyIds ?? requiredProductJourneyIds(catalog, report),
      requiredProductJourneyIds(catalog, report),
      "product journey manifest required IDs",
    );
  }
  if (!isPlainObject(manifest.results) || !Array.isArray(manifest.artifacts)) {
    throw new Error(
      "product journey audit manifest is missing artifact entries",
    );
  }
  const artifactNames = manifest.artifacts.map((artifact, index) => {
    assertBuildArtifactIdentity(
      artifact,
      `product journey manifest entry ${index}`,
    );
    return artifact.name;
  });
  const expectedArtifactNames =
    expectedArtifacts?.map((artifact) => artifact.name) ??
    buildArtifactNamesForJourneyIds(expectedIds, catalog);
  if (JSON.stringify(artifactNames) !== JSON.stringify(expectedArtifactNames)) {
    throw new Error(
      "product journey audit manifest must declare exactly the selected build artifacts in order",
    );
  }
  if (expectedArtifacts) {
    assertProductJourneyArtifactEvidence(
      manifest.artifacts,
      expectedArtifacts,
      "product journey audit manifest build artifacts",
    );
  }
  if (report?.acceptanceRequired === true) {
    if (
      manifest.acceptanceRequired !== true ||
      manifest.rustAcceptanceComplete !== true ||
      manifest.acceptanceComplete !== true ||
      !isPlainObject(manifest.buildReceipt) ||
      !isPlainObject(manifest.c2zcRustAcceptance)
    ) {
      throw new Error(
        "C2-ZC product journey manifest must include complete Rust acceptance evidence",
      );
    }
    assertC2ZcRustAcceptanceEvidenceShape(
      manifest.c2zcRustAcceptance,
      "C2-ZC product journey manifest",
    );
    assertProductJourneyBuildReceiptShape(
      manifest.buildReceipt,
      "C2-ZC product journey manifest",
      {
        candidate,
        artifactNames: expectedArtifactNames,
      },
    );
  }
  if (
    report &&
    manifest.rustAcceptanceComplete !== (report.rustAcceptanceComplete === true)
  ) {
    throw new Error(
      "product journey audit manifest Rust completion does not match results",
    );
  }
  if (
    report &&
    JSON.stringify(manifest.buildReceipt ?? null) !==
      JSON.stringify(report.buildReceipt ?? null)
  ) {
    throw new Error(
      "product journey audit manifest build receipt does not match results",
    );
  }
  if (
    report &&
    JSON.stringify(manifest.requiredJourneyIds ?? report.journeyIds) !==
      JSON.stringify(report.requiredJourneyIds ?? report.journeyIds)
  ) {
    throw new Error(
      "product journey audit manifest required IDs do not match results",
    );
  }
}

function assertArtifactIdentity(
  identity,
  label,
  { requireRequestedPath = false, requireSize = false } = {},
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
  if (
    requireSize &&
    (!Number.isSafeInteger(identity.size) || identity.size < 0)
  ) {
    throw new Error(`${label} artifact size is invalid`);
  }
}

function assertC2ZcRestoreFixtureEvidenceShape(
  evidence,
  label,
  { candidate = null } = {},
) {
  if (!isPlainObject(evidence)) {
    throw new Error(`${label} must include verified fixture evidence`);
  }
  for (const [field, value] of [
    ["path", evidence.path],
    ["manifestPath", evidence.manifestPath],
  ]) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      path.isAbsolute(value) ||
      value.split(/[\\/]/u).includes("..")
    ) {
      throw new Error(`${label} ${field} must be a repository-relative path`);
    }
  }
  if (evidence.manifestPath !== evidence.manifest?.path) {
    throw new Error(`${label} manifest path is not bound to its artifact`);
  }
  if (evidence.path !== evidence.artifacts?.fixture?.path) {
    throw new Error(`${label} fixture path is not bound to its artifact`);
  }
  assertArtifactIdentity(evidence.manifest, `${label} manifest`, {
    requireSize: true,
  });
  assertArtifactIdentity(evidence.artifacts?.fixture, `${label} fixture`, {
    requireSize: true,
  });
  assertArtifactIdentity(evidence.artifacts?.database, `${label} database`, {
    requireSize: true,
  });
  if (
    !isPlainObject(evidence.fixtureManifest) ||
    evidence.manifestVersion !== evidence.fixtureManifest.manifestVersion ||
    evidence.fixtureSha256 !== evidence.fixtureManifest.fixtureSha256 ||
    evidence.fixtureSizeBytes !== evidence.fixtureManifest.fixtureSizeBytes
  ) {
    throw new Error(`${label} manifest summary is not bound to its contents`);
  }
  assertC2ZcRestoreFixtureManifest(
    evidence.fixtureManifest,
    `${label} manifest contents`,
  );
  if (
    evidence.fixtureSha256 !== evidence.artifacts.fixture.sha256 ||
    evidence.fixtureSizeBytes !== evidence.artifacts.fixture.size
  ) {
    throw new Error(
      `${label} fixture digest or size is not bound to its bytes`,
    );
  }
  assertC2ZcFixtureCandidateBinding(
    evidence.fixtureManifest.candidate,
    evidence.candidate,
    `${label} candidate`,
  );
  if (candidate) {
    assertC2ZcFixtureCandidateBinding(
      evidence.fixtureManifest.candidate,
      candidate,
      `${label} Rust candidate`,
    );
  }
  return evidence;
}

function assertBuildArtifactIdentity(identity, label) {
  if (
    !isPlainObject(identity) ||
    JSON.stringify(Object.keys(identity).sort()) !==
      JSON.stringify([...PRODUCT_JOURNEY_BUILD_ARTIFACT_KEYS].sort()) ||
    typeof identity.name !== "string" ||
    identity.name.length === 0 ||
    typeof identity.path !== "string" ||
    typeof identity.requestedPath !== "string" ||
    typeof identity.realPath !== "string" ||
    identity.path.length === 0 ||
    identity.requestedPath.length === 0 ||
    identity.realPath.length === 0 ||
    identity.path.includes("\0") ||
    identity.requestedPath.includes("\0") ||
    identity.realPath.includes("\0") ||
    !Number.isSafeInteger(identity.size) ||
    identity.size < 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(identity.sha256 ?? "")
  ) {
    throw new Error(`${label} build artifact identity is invalid`);
  }
  return identity;
}

function productJourneyCommandForPlan(plan) {
  const stage = plan.stages.find(
    (candidate) => candidate.id === "electron-product-journeys",
  );
  return stage?.commands?.at(-1) ?? null;
}

function productJourneySelectionForPlan(plan, report) {
  const command = productJourneyCommandForPlan(plan);
  const catalog = productJourneyCatalogForCommand(command ?? { env: {} });
  const selectedIds = new Set(report.journeyIds ?? []);
  const journeys = catalog.filter((journey) => selectedIds.has(journey.id));
  if (journeys.length !== selectedIds.size) {
    throw new Error(
      "product journey results include IDs absent from the local CI selection catalog",
    );
  }
  return {
    catalog,
    command,
    environment: { ...process.env, ...(command?.env ?? {}) },
    journeys,
  };
}

/** Collect and validate the immutable product-journey evidence for a Full receipt. */
export async function collectProductJourneyEvidence(
  plan,
  { candidate = null, root = repoRoot } = {},
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
  const selection = productJourneySelectionForPlan(plan, report);
  const expectedBuildArtifacts = (
    await assertBuildArtifacts(selection.journeys, {
      catalog: selection.catalog,
      root,
      env: selection.environment,
    })
  ).artifacts;
  const expectedArtifactNames = expectedBuildArtifacts.map(
    (artifact) => artifact.name,
  );
  const currentCandidate = reportRequiresC2ZcRustAcceptance(report)
    ? (candidate ??
      (await resolveLocalCiCandidate(plan, {
        root,
      })))
    : null;
  const journeyIds = assertPassedProductJourneyResult(report, {
    catalog: selection.catalog,
    expectedArtifactNames,
    expectedArtifacts: expectedBuildArtifacts,
  });
  if (reportRequiresC2ZcRustAcceptance(report)) {
    assertProductJourneyBuildReceiptShape(
      report.buildReceipt,
      "C2-ZC product journey results",
      {
        candidate: currentCandidate,
        artifactNames: expectedArtifactNames,
      },
    );
    assertProductJourneyArtifactEvidence(
      report.buildReceipt.artifacts,
      expectedBuildArtifacts,
      "C2-ZC product journey results build artifacts",
    );
  }
  assertPassedProductJourneyManifest(manifest, journeyIds, report, {
    candidate: currentCandidate,
    catalog: selection.catalog,
    expectedArtifacts: expectedBuildArtifacts,
  });
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
    assertArtifactIdentity(artifact, label, {
      requireRequestedPath: true,
      requireSize: true,
    });
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
      currentRequestedPath.sha256 !== artifact.sha256 ||
      currentPath.size !== artifact.size ||
      currentRequestedPath.size !== artifact.size
    ) {
      throw new Error(
        `product journey manifest artifact ${artifact.name ?? artifact.path} changed after preflight`,
      );
    }
    buildArtifacts.push({
      ...artifact,
      realPath: currentPath.realPath,
      size: currentPath.size,
      sha256: currentPath.sha256,
    });
  }
  if (reportRequiresC2ZcRustAcceptance(report)) {
    assertProductJourneyArtifactEvidence(
      report.buildReceipt?.artifacts,
      buildArtifacts,
      "C2-ZC product journey build receipt artifacts",
    );
  }
  const artifacts = [...files, ...buildArtifacts].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  let c2zcRustAcceptance = null;
  if (reportRequiresC2ZcRustAcceptance(report)) {
    const reported = report.c2zcRustAcceptance;
    if (
      !isPlainObject(reported) ||
      reported.verified !== true ||
      typeof reported.receiptPath !== "string" ||
      typeof reported.receiptSha256 !== "string" ||
      !Array.isArray(reported.gates)
    ) {
      throw new Error(
        "C2-ZC product journey results must bind a verified Rust acceptance receipt",
      );
    }
    const expectedReceiptPath = resolveC2ZcRustAcceptanceReceiptPath(plan, {
      root,
    });
    if (path.resolve(root, reported.receiptPath) !== expectedReceiptPath) {
      throw new Error(
        "C2-ZC product journey results use an unexpected Rust receipt path",
      );
    }
    const verifiedRustReceipt = await verifyC2ZcRustAcceptanceReceipt({
      root,
      candidate: currentCandidate,
      catalogDigest: C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
      receiptPath: reported.receiptPath,
      receiptSha256: reported.receiptSha256,
    });
    c2zcRustAcceptance = {
      required: true,
      verified: true,
      receiptPath: verifiedRustReceipt.receiptPath,
      receiptSha256: verifiedRustReceipt.receiptSha256,
      candidate: verifiedRustReceipt.receipt.candidate,
      gates: verifiedRustReceipt.receipt.gates,
      receipt: verifiedRustReceipt.receipt,
    };
    if (
      c2zcRustAcceptance.receiptPath !== reported.receiptPath ||
      c2zcRustAcceptance.receiptSha256 !== reported.receiptSha256 ||
      JSON.stringify(c2zcRustAcceptance.receipt) !==
        JSON.stringify(reported.receipt) ||
      JSON.stringify(c2zcRustAcceptance.receipt.candidate) !==
        JSON.stringify(reported.candidate) ||
      JSON.stringify(c2zcRustAcceptance.receipt.gates) !==
        JSON.stringify(reported.gates)
    ) {
      throw new Error(
        "C2-ZC product journey results do not match the verified Rust receipt",
      );
    }
    if (
      !isPlainObject(manifest.c2zcRustAcceptance) ||
      manifest.c2zcRustAcceptance.receiptPath !== reported.receiptPath ||
      manifest.c2zcRustAcceptance.receiptSha256 !== reported.receiptSha256 ||
      manifest.c2zcRustAcceptance.verified !== true ||
      JSON.stringify(manifest.c2zcRustAcceptance) !== JSON.stringify(reported)
    ) {
      throw new Error(
        "C2-ZC product journey manifest does not bind the verified Rust receipt",
      );
    }
  }

  return {
    catalogDigest: report.catalogDigest,
    journeyIds,
    requiredJourneyIds:
      report.requiredJourneyIds ?? requiredProductJourneyIds(selection.catalog),
    allPassed: true,
    allClean: true,
    results: resultEvidence,
    manifest: manifestEvidence,
    artifacts,
    artifactDigest: digestJson(artifacts),
    acceptanceRequired: report.acceptanceRequired === true,
    rustAcceptanceComplete: report.rustAcceptanceComplete === true,
    buildReceipt: report.buildReceipt ?? null,
    acceptanceComplete: report.acceptanceComplete === true,
    c2zcRustAcceptance,
  };
}

function verifyProductJourneyEvidence(
  receiptEvidence,
  currentEvidence,
  { candidate = null } = {},
) {
  if (!isPlainObject(receiptEvidence)) {
    throw new Error("Full receipt product journey evidence is required.");
  }
  const catalog = productJourneyCatalogForDigest(receiptEvidence.catalogDigest);
  if (!catalog) {
    throw new Error(
      "Full receipt product journey catalog digest is not recognized.",
    );
  }
  const expectedIds = catalog.map((journey) => journey.id);
  const expectedBuildArtifactNames =
    receiptEvidence.acceptanceRequired === true
      ? buildArtifactNamesForJourneyIds(receiptEvidence.journeyIds, catalog)
      : null;
  assertStringArrayEqual(
    receiptEvidence.journeyIds,
    expectedIds,
    "Full receipt product journey evidence",
  );
  const requiredIds = requiredProductJourneyIds(catalog, receiptEvidence);
  assertStringArrayEqual(
    receiptEvidence.requiredJourneyIds ?? requiredIds,
    requiredIds,
    "Full receipt required product journey evidence",
  );
  if (receiptEvidence.allPassed !== true || receiptEvidence.allClean !== true) {
    throw new Error(
      "Full receipt product journey evidence must be passed and clean.",
    );
  }
  if (receiptEvidence.acceptanceRequired === true) {
    if (
      receiptEvidence.rustAcceptanceComplete !== true ||
      receiptEvidence.acceptanceComplete !== true ||
      !isPlainObject(receiptEvidence.buildReceipt) ||
      !isPlainObject(receiptEvidence.c2zcRustAcceptance)
    ) {
      throw new Error("Full receipt C2-ZC acceptance evidence is incomplete.");
    }
    assertProductJourneyBuildReceiptShape(
      receiptEvidence.buildReceipt,
      "Full receipt C2-ZC build evidence",
      {
        candidate,
        artifactNames: expectedBuildArtifactNames,
      },
    );
    assertC2ZcRustAcceptanceEvidenceShape(
      receiptEvidence.c2zcRustAcceptance,
      "Full receipt C2-ZC acceptance evidence",
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
  if (receiptEvidence.acceptanceRequired === true) {
    if (
      digestJson(receiptEvidence.artifacts) !== receiptEvidence.artifactDigest
    ) {
      throw new Error(
        "Full receipt product journey artifact digest does not match its entries.",
      );
    }
    const namedArtifacts = receiptEvidence.artifacts.filter(
      (artifact) => typeof artifact?.name === "string",
    );
    const namedArtifactsByName = new Map(
      namedArtifacts.map((artifact) => [artifact.name, artifact]),
    );
    if (
      namedArtifacts.length !== expectedBuildArtifactNames.length ||
      namedArtifactsByName.size !== namedArtifacts.length ||
      expectedBuildArtifactNames.some((name) => !namedArtifactsByName.has(name))
    ) {
      throw new Error(
        "Full receipt product journey evidence must include exactly the selected build artifacts.",
      );
    }
    assertProductJourneyArtifactEvidence(
      expectedBuildArtifactNames.map((name) => namedArtifactsByName.get(name)),
      receiptEvidence.buildReceipt.artifacts,
      "Full receipt product journey build artifact evidence",
    );
    for (const field of ["results", "manifest"]) {
      const referencedArtifact = receiptEvidence.artifacts.find(
        (artifact) => artifact.path === receiptEvidence[field].path,
      );
      if (
        !referencedArtifact ||
        referencedArtifact.realPath !== receiptEvidence[field].realPath ||
        referencedArtifact.sha256 !== receiptEvidence[field].sha256 ||
        (receiptEvidence[field].size !== undefined &&
          referencedArtifact.size !== receiptEvidence[field].size)
      ) {
        throw new Error(
          `Full receipt product journey ${field} is not bound to artifact evidence.`,
        );
      }
    }
  }
  if (currentEvidence) {
    for (const field of [
      "catalogDigest",
      "journeyIds",
      "allPassed",
      "allClean",
      "artifactDigest",
      "acceptanceRequired",
      "rustAcceptanceComplete",
      "buildReceipt",
      "acceptanceComplete",
      "c2zcRustAcceptance",
      "requiredJourneyIds",
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
    if (receipt.productJourneyEvidence?.acceptanceRequired === true) {
      assertC2ZcRestoreFixtureEvidenceShape(
        receipt.c2zcRestoreFixture,
        "Full receipt C2-ZC restore fixture",
        { candidate },
      );
    }
    verifyProductJourneyEvidence(
      receipt.productJourneyEvidence,
      currentProductJourneyEvidence,
      { candidate },
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

function bindC2ZcRustGateCommand(command, stageId, { plan, candidate }) {
  if (stageId !== C2ZC_RUST_ACCEPTANCE_GATE_STAGE || !candidate) {
    return command;
  }
  return {
    ...command,
    env: {
      ...command.env,
      [C2ZC_RUST_REQUESTED_BASE_ENV]: plan.comparison.base,
      [C2ZC_RUST_REQUESTED_HEAD_ENV]: plan.comparison.head,
      [C2ZC_RUST_CANDIDATE_JSON_ENV]: JSON.stringify(candidate),
    },
  };
}

function productJourneyCatalogForCommand(command) {
  const name = command.env?.GRIMODEX_PRODUCT_JOURNEY_SET ?? "";
  if (name === "c2-zc") return NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG;
  if (name === "c2-5b") {
    return NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG;
  }
  if (name !== "") return [];
  const serializedIds = command.env?.GRIMODEX_PRODUCT_JOURNEY_IDS;
  if (typeof serializedIds !== "string" || serializedIds === "") {
    return PRODUCT_JOURNEY_CATALOG;
  }
  try {
    const ids = JSON.parse(serializedIds);
    if (!Array.isArray(ids)) return [];
    const selected = new Set(ids);
    return PRODUCT_JOURNEY_CATALOG.filter((journey) =>
      selected.has(journey.id),
    );
  } catch {
    return [];
  }
}

async function bindC2ZcProductJourneyCommand(
  command,
  stageId,
  {
    root,
    plan,
    candidate,
    buildStagePassed = false,
    restoreFixtureInput = null,
  },
) {
  if (stageId !== "electron-product-journeys") return command;
  const configuredPath = command.env?.[C2ZC_RUST_RECEIPT_PATH_ENV];
  const selectedCatalog = productJourneyCatalogForCommand(command);
  const isC2ZcSelection = selectedCatalog.some(
    (journey) => journey.id === C2ZC_PRODUCT_JOURNEY_ID,
  );
  const boundEnv = {
    ...command.env,
    [C2ZC_RUST_REQUESTED_BASE_ENV]: plan.comparison.base,
    [C2ZC_RUST_REQUESTED_HEAD_ENV]: plan.comparison.head,
  };
  if (
    isC2ZcSelection &&
    (command.args?.includes("electron:product-journeys") ||
      command.label === "Run every product journey")
  ) {
    boundEnv[C2ZC_RESTORE_FIXTURE_ENV] = restoreFixtureInput
      ? JSON.stringify({
          path: restoreFixtureInput.path,
          manifest: restoreFixtureInput.manifestPath,
        })
      : "";
  }
  delete boundEnv[PRODUCT_JOURNEY_BUILD_RECEIPT_ENV];
  if (candidate && buildStagePassed) {
    try {
      const artifacts = (
        await assertBuildArtifacts(selectedCatalog, {
          catalog: selectedCatalog,
          root,
          env: { ...process.env, ...command.env },
        })
      ).artifacts;
      if (artifacts.length === 0) {
        throw new Error(
          "product journey build stage resolved no capability artifacts",
        );
      }
      boundEnv[PRODUCT_JOURNEY_BUILD_RECEIPT_ENV] = JSON.stringify({
        version: 1,
        verified: true,
        source: "local-ci-candidate",
        candidate,
        artifacts,
      });
    } catch {
      // A receipt is only an attestation after every preceding build command
      // passed and the exact selected artifacts were captured.  The product
      // runner will fail closed if this command still executes without one.
    }
  }
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    return { ...command, env: boundEnv };
  }
  let receiptSha256;
  try {
    receiptSha256 = (
      await readFile(`${path.resolve(root, configuredPath)}.sha256`, "utf8")
    ).trim();
  } catch {
    return { ...command, env: boundEnv };
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(receiptSha256)) {
    return { ...command, env: boundEnv };
  }
  return {
    ...command,
    env: {
      ...boundEnv,
      GRIMODEX_C2ZC_RUST_RECEIPT_SHA256: receiptSha256,
    },
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
    root = repoRoot,
  } = {},
) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const stages = [];
  let failedStage = null;
  let c2zcRestoreFixtureContext = null;

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
      const fixtureBinding = await bindC2ZcRestoreFixtureCommand(
        command,
        stage.id,
        {
          root,
          plan,
          candidate,
          context: c2zcRestoreFixtureContext,
        },
      );
      c2zcRestoreFixtureContext = fixtureBinding.context;
      const rustBoundCommand = bindC2ZcRustGateCommand(command, stage.id, {
        plan,
        candidate,
      });
      const boundCommand = await bindC2ZcProductJourneyCommand(
        {
          ...rustBoundCommand,
          ...(fixtureBinding.command === command
            ? {}
            : { args: fixtureBinding.command.args }),
        },
        stage.id,
        {
          root,
          plan,
          candidate,
          restoreFixtureInput: c2zcRestoreFixtureContext?.input,
          buildStagePassed:
            stage.id === "electron-product-journeys" &&
            commands.length > 0 &&
            commands.every((entry) => entry.status === "passed"),
        },
      );
      if (failedCommand) {
        commands.push(
          notRunCommand(boundCommand, `Fail-fast after ${failedCommand}.`),
        );
        continue;
      }
      notify({ command: boundCommand, stage, type: "command-start" });
      let execution;
      try {
        execution = await execute(boundCommand);
      } catch (error) {
        execution = {
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
          exitCode: null,
          signal: null,
        };
      }
      let status = execution.exitCode === 0 ? "passed" : "failed";
      if (status === "passed" && stage.id === C2ZC_RESTORE_FIXTURE_STAGE) {
        try {
          const operation = fixtureCommandOperation(boundCommand);
          await validateC2ZcRestoreFixtureContext(c2zcRestoreFixtureContext);
          if (operation === "verify") {
            c2zcRestoreFixtureContext.evidence =
              await captureC2ZcRestoreFixtureEvidence(
                c2zcRestoreFixtureContext,
                root,
              );
          }
        } catch (error) {
          execution = {
            ...execution,
            error: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          };
          status = "failed";
        }
      }
      commands.push({ ...boundCommand, ...execution, status });
      notify({
        command: boundCommand,
        execution,
        stage,
        status,
        type: "command-end",
      });
      if (status === "failed") failedCommand = boundCommand.label;
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
    if (
      stage.id === "electron-product-journeys" &&
      c2zcRestoreFixtureContext?.outputDir
    ) {
      await rm(c2zcRestoreFixtureContext.outputDir, {
        recursive: true,
        force: true,
      });
      c2zcRestoreFixtureContext.outputDir = null;
    }
    if (status === "failed") failedStage = stage.id;
  }

  if (c2zcRestoreFixtureContext?.outputDir) {
    await rm(c2zcRestoreFixtureContext.outputDir, {
      recursive: true,
      force: true,
    });
    c2zcRestoreFixtureContext.outputDir = null;
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
    c2zcRestoreFixture: c2zcRestoreFixtureContext?.evidence ?? null,
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
        ? await collectProductJourneyEvidence(plan, { candidate })
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
    root: repoRoot,
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
        result.productJourneyEvidence = await collectProductJourneyEvidence(
          plan,
          {
            candidate: finishedCandidate,
          },
        );
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
