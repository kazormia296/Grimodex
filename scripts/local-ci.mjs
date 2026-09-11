#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
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
  assertC2ZcProductJourneyFixtureSummary,
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
import { validateWebEditorArtifact } from "./validate-web-editor-artifact.mjs";
import { runLocalCiTasks, validateLocalCiTasks } from "./local-ci-runner.mjs";
import { runLocalCiCommand } from "./local-ci-process-supervisor.mjs";

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
const C2ZC_RESTORE_FIXTURE_EVIDENCE_DIR = path.join(
  ".artifacts",
  "local-ci",
  "c2-zc-restore-fixture",
);
const C2ZC_RESTORE_FIXTURE_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const C2ZC_FULL_STAGE_ORDER = Object.freeze([
  "bootstrap",
  C2ZC_RUST_ACCEPTANCE_GATE_STAGE,
  C2ZC_RESTORE_FIXTURE_STAGE,
  "electron-native",
  "electron",
  "frontend",
  "webgl",
  "electron-product-journeys",
  "migration-recovery-gate",
  "rust",
  "browser",
  "storybook",
  "quality",
  "lfm-encoder-phase0",
  "security",
  "electron-runtime-performance",
]);
const LOCAL_CI_FULL_DEADLINE_MS = 600_000;
const C2ZC_RESTORE_FIXTURE_DIAGNOSTIC_VERSION = 1;
const C2ZC_RESTORE_FIXTURE_DIAGNOSTIC_MAX_ERROR_LENGTH = 512;
const C2ZC_RUST_REQUESTED_BASE_ENV = "GRIMODEX_C2ZC_RUST_REQUESTED_BASE";
const C2ZC_RUST_REQUESTED_HEAD_ENV = "GRIMODEX_C2ZC_RUST_REQUESTED_HEAD";
const C2ZC_RUST_CANDIDATE_JSON_ENV = "GRIMODEX_C2ZC_RUST_CANDIDATE_JSON";
const C2ZC_RUST_RECEIPT_PATH_ENV = "GRIMODEX_C2ZC_RUST_RECEIPT_PATH";
const C2ZC_RUST_RECEIPT_SHA256_ENV = "GRIMODEX_C2ZC_RUST_RECEIPT_SHA256";
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

function assertC2ZcStageOrder(stageIds, label) {
  if (!Array.isArray(stageIds)) {
    throw new Error(`${label} must define an ordered stage list`);
  }
  const start = stageIds.indexOf(C2ZC_FULL_STAGE_ORDER[0]);
  const observed =
    start === -1
      ? []
      : stageIds.slice(start, start + C2ZC_FULL_STAGE_ORDER.length);
  if (JSON.stringify(observed) !== JSON.stringify(C2ZC_FULL_STAGE_ORDER)) {
    throw new Error(
      `${label} must keep the exact C2-ZC stage order: ${C2ZC_FULL_STAGE_ORDER.join(" -> ")}`,
    );
  }
}

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
  if (!Number.isSafeInteger(registry.maxSlots) || registry.maxSlots < 1) {
    throw new Error("local CI maxSlots must be a positive integer");
  }
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
      requireString(command.id, `${label} id`);
      requireStringArray(command.after ?? [], `${label} after`);
      assertUnique(command.after ?? [], `${label} after`);
      if (
        command.lane !== undefined &&
        (typeof command.lane !== "string" || command.lane.length === 0)
      ) {
        throw new Error(`${label} lane must be a non-empty string`);
      }
      if (
        command.slots !== undefined &&
        (!Number.isSafeInteger(command.slots) || command.slots < 1)
      ) {
        throw new Error(`${label} slots must be a positive integer`);
      }
      if (
        command.timeoutMs !== undefined &&
        (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1)
      ) {
        throw new Error(`${label} timeoutMs must be a positive integer`);
      }
      if (command.obligations !== undefined) {
        requireStringArray(command.obligations, `${label} obligations`);
        assertUnique(command.obligations, `${label} obligations`);
      }
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
  assertC2ZcStageOrder(
    registry.profiles.full,
    "local CI full profile C2-ZC stages",
  );

  const allCommands = Object.values(registry.stages).flatMap(
    (stage) => stage.commands,
  );
  validateLocalCiTasks(allCommands, { maxSlots: registry.maxSlots });
  const fullCommands = registry.profiles.full.flatMap(
    (stageId) => registry.stages[stageId].commands,
  );
  const obligations = fullCommands.flatMap(
    (command) => command.obligations ?? [command.id],
  );
  if (obligations.length !== 52 || new Set(obligations).size !== 52) {
    throw new Error("local CI Full must map exactly 52 unique obligations");
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
    id: command.id,
    label: command.label,
    command: command.command,
    args,
    cwd: command.cwd ?? ".",
    env: { ...(stage.env ?? {}), ...(command.env ?? {}) },
    ...(command.after === undefined ? {} : { after: [...command.after] }),
    ...(command.lane === undefined ? {} : { lane: command.lane }),
    ...(command.slots === undefined ? {} : { slots: command.slots }),
    ...(command.timeoutMs === undefined
      ? {}
      : { timeoutMs: command.timeoutMs }),
    ...(command.obligations === undefined
      ? {}
      : { obligations: [...command.obligations] }),
  };
}

function taskCommandDescriptor(command) {
  return {
    label: command.label,
    command: command.command,
    args: [...command.args],
    cwd: command.cwd,
    env: { ...command.env },
  };
}

export function createLocalCiPlanDescriptor(plan) {
  return {
    profile: plan.profile,
    comparison: plan.comparison,
    coverage: plan.coverage,
    registryDigest: plan.registryDigest,
    maxSlots: plan.maxSlots,
    releaseOnlyJobs: plan.releaseOnlyJobs,
    tasks: plan.tasks,
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
  const includedTaskIds = new Set(
    stages.flatMap((stage) => stage.commands.map((command) => command.id)),
  );
  const tasks = stages.flatMap((stage) =>
    stage.commands.map((command, commandIndex) => ({
      id: command.id,
      stageId: stage.id,
      stageLabel: stage.label,
      commandIndex,
      command: taskCommandDescriptor(command),
      after: (command.after ?? []).filter((id) => includedTaskIds.has(id)),
      ...(command.lane === undefined ? {} : { lane: command.lane }),
      ...(command.slots === undefined ? {} : { slots: command.slots }),
      ...(command.timeoutMs === undefined
        ? {}
        : { timeoutMs: command.timeoutMs }),
      ...(command.obligations === undefined
        ? {}
        : { obligations: [...command.obligations] }),
    })),
  );
  return {
    comparison,
    coverage: {
      completeness: from === null ? "complete" : "partial",
      fromStage: from,
    },
    profile,
    maxSlots: registry.maxSlots,
    registryDigest: digestJson(registry),
    releaseOnlyJobs,
    stages,
    tasks,
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
  { root = repoRoot, runId = null } = {},
) {
  const stage = plan.stages.find(
    (candidate) => candidate.id === "electron-product-journeys",
  );
  const configured = stage?.commands
    .map((command) => command.env?.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR)
    .find((value) => value !== undefined && value !== "");
  const artifactDirectory = configured ?? PRODUCT_JOURNEY_ARTIFACT_DIR;
  if (!artifactDirectory.includes("__LOCAL_CI_RUN_ID__")) {
    return path.resolve(root, artifactDirectory);
  }
  assertC2ZcRestoreFixtureRunId(runId, "Product journey evidence run");
  return path.resolve(
    root,
    artifactDirectory.replaceAll("__LOCAL_CI_RUN_ID__", runId),
  );
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

function assertC2ZcRestoreFixtureRunId(runId, label) {
  if (
    typeof runId !== "string" ||
    !C2ZC_RESTORE_FIXTURE_RUN_ID_PATTERN.test(runId)
  ) {
    throw new Error(`${label} must be a UUIDv4`);
  }
}

function c2zcRestoreFixtureArtifactPaths(directory) {
  return {
    fixturePath: path.join(directory, C2ZC_RESTORE_FIXTURE_BACKUP_NAME),
    databasePath: path.join(directory, C2ZC_RESTORE_FIXTURE_DATABASE_NAME),
    manifestPath: path.join(directory, C2ZC_RESTORE_FIXTURE_MANIFEST_NAME),
  };
}

function c2zcRestoreFixtureEvidenceDirectory(root, runId) {
  assertC2ZcRestoreFixtureRunId(runId, "C2-ZC restore fixture run");
  return path.join(root, C2ZC_RESTORE_FIXTURE_EVIDENCE_DIR, runId);
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

export async function captureC2ZcRestoreFixtureEvidence(
  context,
  root,
  { runId = randomUUID(), beforePublish = null } = {},
) {
  if (!context?.input?.manifestPath) {
    throw new Error("C2-ZC restore fixture was not loaded after verification");
  }
  const evidenceDirectory = path.resolve(
    root,
    C2ZC_RESTORE_FIXTURE_EVIDENCE_DIR,
  );
  const finalDirectory = c2zcRestoreFixtureEvidenceDirectory(root, runId);
  try {
    await stat(finalDirectory);
    throw new Error(
      `C2-ZC restore fixture evidence run ${runId} already exists`,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(evidenceDirectory, { recursive: true });
  const stagedDirectory = await mkdtemp(
    path.join(evidenceDirectory, `.c2zc-restore-fixture-${runId}-`),
  );
  const stagedPaths = c2zcRestoreFixtureArtifactPaths(stagedDirectory);
  const destinationPaths = c2zcRestoreFixtureArtifactPaths(finalDirectory);
  try {
    await copyFile(context.fixturePath, stagedPaths.fixturePath);
    await copyFile(context.databasePath, stagedPaths.databasePath);
    await copyFile(context.manifestPath, stagedPaths.manifestPath);
    await readC2ZcRestoreFixtureEvidence(stagedPaths, {
      root,
      candidate: context.candidate,
      label: "C2-ZC staged restore fixture",
    });
    if (beforePublish !== null) {
      if (typeof beforePublish !== "function") {
        throw new Error(
          "C2-ZC restore fixture beforePublish must be a function",
        );
      }
      await beforePublish({
        finalDirectory,
        stagedDirectory,
        stagedPaths,
      });
    }
    await rename(stagedDirectory, finalDirectory);
    return readC2ZcRestoreFixtureEvidence(destinationPaths, {
      root,
      candidate: context.candidate,
      label: "C2-ZC copied restore fixture",
    });
  } finally {
    // Do not sweep abandoned dot-prefix staging directories automatically:
    // a concurrent active capture must never be mistaken for an orphan.  A
    // SIGKILL can intentionally leave one behind; normal paths clean up here.
    await rm(stagedDirectory, { recursive: true, force: true });
  }
}

function resolveC2ZcRestoreFixtureEvidencePaths(
  evidence,
  { root = repoRoot, label = "C2-ZC restore fixture evidence" } = {},
) {
  if (!isPlainObject(evidence)) {
    throw new Error(`${label} is required`);
  }
  if (
    evidence.path !== evidence.artifacts?.fixture?.path ||
    evidence.manifestPath !== evidence.manifest?.path
  ) {
    throw new Error(`${label} paths must bind to their artifact identities`);
  }
  const resolveRepositoryPath = (value, field) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      path.isAbsolute(value) ||
      value.split(/[\\/]/u).includes("..")
    ) {
      throw new Error(`${label} ${field} must be repository-relative`);
    }
    const resolved = path.resolve(root, value);
    const relative = path.relative(path.resolve(root), resolved);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`${label} ${field} must stay inside the repository`);
    }
    return resolved;
  };
  const fixturePath = resolveRepositoryPath(evidence.path, "fixture");
  const databasePath = resolveRepositoryPath(
    evidence.artifacts?.database?.path,
    "database",
  );
  const manifestPath = resolveRepositoryPath(evidence.manifestPath, "manifest");
  const fixtureDirectory = path.dirname(fixturePath);
  const evidenceDirectory = path.resolve(
    root,
    C2ZC_RESTORE_FIXTURE_EVIDENCE_DIR,
  );
  const runId = path.relative(evidenceDirectory, fixtureDirectory);
  if (
    fixtureDirectory !== path.dirname(databasePath) ||
    fixtureDirectory !== path.dirname(manifestPath) ||
    path.basename(fixturePath) !== C2ZC_RESTORE_FIXTURE_BACKUP_NAME ||
    path.basename(databasePath) !== C2ZC_RESTORE_FIXTURE_DATABASE_NAME ||
    path.basename(manifestPath) !== C2ZC_RESTORE_FIXTURE_MANIFEST_NAME
  ) {
    throw new Error(
      `${label} paths must share the canonical artifact directory`,
    );
  }
  assertC2ZcRestoreFixtureRunId(runId, `${label} run`);
  return { fixturePath, databasePath, manifestPath, runId };
}

function assertC2ZcRestoreFixtureRunBinding(evidence, runId, label) {
  assertC2ZcRestoreFixtureRunId(runId, `${label} run`);
  const prefix = `${C2ZC_RESTORE_FIXTURE_EVIDENCE_DIR.split(path.sep).join(
    "/",
  )}/${runId}/`;
  for (const [field, value, name] of [
    ["fixture", evidence?.path, C2ZC_RESTORE_FIXTURE_BACKUP_NAME],
    [
      "database",
      evidence?.artifacts?.database?.path,
      C2ZC_RESTORE_FIXTURE_DATABASE_NAME,
    ],
    ["manifest", evidence?.manifestPath, C2ZC_RESTORE_FIXTURE_MANIFEST_NAME],
  ]) {
    if (value !== `${prefix}${name}`) {
      throw new Error(`${label} ${field} path is not bound to its run`);
    }
  }
}

function artifactIdentityWithoutRequestedPath(identity) {
  return {
    path: identity.path,
    realPath: identity.realPath,
    size: identity.size,
    sha256: identity.sha256,
  };
}

/**
 * Re-read the copied fixture and manifest.  This intentionally derives every
 * byte identity from disk rather than trusting a receipt's stored shape.
 */
export async function readC2ZcRestoreFixtureEvidence(
  { fixturePath, databasePath, manifestPath },
  { root = repoRoot, candidate = null, label = "C2-ZC restore fixture" } = {},
) {
  const input = await loadC2ZcRestoreFixtureInput({
    path: fixturePath,
    manifest: manifestPath,
  });
  const manifestBase = path.dirname(path.resolve(manifestPath));
  const expectedFixturePath = path.resolve(
    manifestBase,
    input.manifest.artifacts.fixture.path,
  );
  const expectedDatabasePath = path.resolve(
    manifestBase,
    input.manifest.artifacts.database.path,
  );
  const [fixture, database, manifest] = await Promise.all([
    resolveArtifactEvidence(fixturePath, { root }),
    resolveArtifactEvidence(databasePath, { root }),
    resolveArtifactEvidence(manifestPath, { root }),
  ]);
  const [
    expectedFixtureRealPath,
    expectedDatabaseRealPath,
    expectedManifestRealPath,
  ] = await Promise.all([
    realpath(expectedFixturePath),
    realpath(expectedDatabasePath),
    realpath(manifestPath),
  ]);
  if (
    fixture.realPath !== expectedFixtureRealPath ||
    database.realPath !== expectedDatabaseRealPath ||
    manifest.realPath !== expectedManifestRealPath ||
    fixture.sha256 !== input.manifest.artifacts.fixture.sha256 ||
    fixture.size !== input.manifest.artifacts.fixture.sizeBytes ||
    database.sha256 !== input.manifest.artifacts.database.sha256 ||
    database.size !== input.manifest.artifacts.database.sizeBytes ||
    input.manifest.fixtureSha256 !== fixture.sha256 ||
    input.manifest.fixtureSizeBytes !== fixture.size
  ) {
    throw new Error(
      `${label} bytes, realpaths, or manifest artifacts do not match`,
    );
  }
  assertC2ZcFixtureCandidateBinding(
    input.manifest.candidate,
    candidate ?? input.manifest.candidate,
    `${label} candidate`,
  );
  const evidence = {
    path: fixture.path,
    manifestPath: manifest.path,
    manifest: artifactIdentityWithoutRequestedPath(manifest),
    artifacts: {
      fixture: artifactIdentityWithoutRequestedPath(fixture),
      database: artifactIdentityWithoutRequestedPath(database),
    },
    fixtureManifest: input.manifest,
    manifestVersion: input.manifest.manifestVersion,
    manifestSha256: manifest.sha256,
    manifestSizeBytes: manifest.size,
    fixtureSha256: input.manifest.fixtureSha256,
    fixtureSizeBytes: input.manifest.fixtureSizeBytes,
    semanticContentsDigest: input.manifest.semantic.contentsDigest,
    contractVersion: input.manifest.contractVersion,
    builderVersion: input.manifest.builderVersion,
    candidate: input.manifest.candidate,
    candidateHeadSha: input.manifest.candidate.resolvedHeadSha,
    candidateTreeSha: input.manifest.candidate.resolvedTreeSha,
    candidateStatusSha256: input.manifest.candidate.statusSha256,
  };
  assertC2ZcRestoreFixtureEvidenceShape(evidence, label, { candidate });
  return evidence;
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
    evidence.receipt.version !== 2 ||
    !Array.isArray(evidence.gates) ||
    JSON.stringify(evidence.gates.map((gate) => gate?.id)) !==
      JSON.stringify(C2ZC_RUST_ACCEPTANCE_GATE_IDS) ||
    JSON.stringify(evidence.gates) !== JSON.stringify(evidence.receipt.gates) ||
    JSON.stringify(evidence.candidate) !==
      JSON.stringify(evidence.receipt.candidate)
  ) {
    throw new Error(`${label} must include all ordered Rust acceptance gates`);
  }
  if (
    !isPlainObject(evidence.verifyOutcome) ||
    JSON.stringify(evidence.verifyOutcome) !==
      JSON.stringify(evidence.receipt.verifyOutcome)
  ) {
    throw new Error(
      `${label} must propagate the verified Rust Verify outcome exactly`,
    );
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
    expectedFixtureEvidence = null,
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
    if (expectedFixtureEvidence !== null) {
      assertC2ZcProductJourneyFixtureSummary(
        report.c2zcRestoreFixture,
        c2zcFixtureSummary(expectedFixtureEvidence),
        "C2-ZC product journey results fixture summary",
      );
    }
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
    expectedFixtureEvidence = null,
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
    if (expectedFixtureEvidence !== null) {
      assertC2ZcProductJourneyFixtureSummary(
        manifest.c2zcRestoreFixture,
        c2zcFixtureSummary(expectedFixtureEvidence),
        "C2-ZC product journey manifest fixture summary",
      );
      assertC2ZcProductJourneyFixtureSummary(
        manifest.c2zcRestoreFixture,
        report.c2zcRestoreFixture,
        "C2-ZC product journey manifest/report fixture summary",
      );
    }
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
    evidence.manifestSha256 !== evidence.manifest?.sha256 ||
    evidence.manifestSizeBytes !== evidence.manifest?.size ||
    evidence.fixtureSha256 !== evidence.fixtureManifest.fixtureSha256 ||
    evidence.fixtureSizeBytes !== evidence.fixtureManifest.fixtureSizeBytes ||
    evidence.semanticContentsDigest !==
      evidence.fixtureManifest.semantic?.contentsDigest ||
    evidence.contractVersion !== evidence.fixtureManifest.contractVersion ||
    evidence.builderVersion !== evidence.fixtureManifest.builderVersion ||
    evidence.candidateHeadSha !==
      evidence.fixtureManifest.candidate?.resolvedHeadSha ||
    evidence.candidateTreeSha !==
      evidence.fixtureManifest.candidate?.resolvedTreeSha ||
    evidence.candidateStatusSha256 !==
      evidence.fixtureManifest.candidate?.statusSha256
  ) {
    throw new Error(`${label} manifest summary is not bound to its contents`);
  }
  assertC2ZcRestoreFixtureManifest(
    evidence.fixtureManifest,
    `${label} manifest contents`,
  );
  if (
    evidence.fixtureSha256 !== evidence.artifacts.fixture.sha256 ||
    evidence.fixtureSizeBytes !== evidence.artifacts.fixture.size ||
    evidence.manifestSha256 !== evidence.manifest.sha256 ||
    evidence.manifestSizeBytes !== evidence.manifest.size
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

function c2zcFixtureSummary(evidence) {
  return {
    manifestVersion: evidence.manifestVersion,
    manifestSha256: evidence.manifestSha256,
    fixtureSha256: evidence.fixtureSha256,
    fixtureSizeBytes: evidence.fixtureSizeBytes,
    semanticContentsDigest: evidence.semanticContentsDigest,
    contractVersion: evidence.contractVersion,
    builderVersion: evidence.builderVersion,
    candidateHeadSha: evidence.candidateHeadSha,
    candidateTreeSha: evidence.candidateTreeSha,
    candidateStatusSha256: evidence.candidateStatusSha256,
  };
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
  {
    candidate = null,
    root = repoRoot,
    restoreFixtureEvidence = null,
    runId = null,
  } = {},
) {
  const artifactRoot = resolveProductJourneyArtifactDirectory(plan, {
    root,
    runId,
  });
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
  const plannedC2ZcAcceptance =
    plan.profile === "full"
      ? expectedC2ZcAcceptanceForPlan(plan)
      : reportRequiresC2ZcRustAcceptance(report);
  if (
    plan.profile === "full" &&
    report.acceptanceRequired !== plannedC2ZcAcceptance
  ) {
    throw new Error(
      "C2-ZC product journey results acceptance requirement does not match the planned selection",
    );
  }
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
  const currentCandidate = plannedC2ZcAcceptance
    ? (candidate ??
      (await resolveLocalCiCandidate(plan, {
        root,
      })))
    : null;
  const expectedFixtureEvidence =
    plan.profile === "full" && plannedC2ZcAcceptance
      ? await readC2ZcRestoreFixtureEvidence(
          resolveC2ZcRestoreFixtureEvidencePaths(restoreFixtureEvidence, {
            root,
            label: "C2-ZC run-bound restore fixture evidence",
          }),
          { root, candidate: currentCandidate },
        )
      : null;
  const journeyIds = assertPassedProductJourneyResult(report, {
    catalog: selection.catalog,
    expectedArtifactNames,
    expectedArtifacts: expectedBuildArtifacts,
    expectedFixtureEvidence,
  });
  if (plannedC2ZcAcceptance) {
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
    expectedFixtureEvidence,
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
  if (plannedC2ZcAcceptance) {
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
  if (plannedC2ZcAcceptance) {
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
      verifyOutcome: verifiedRustReceipt.receipt.verifyOutcome,
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
        JSON.stringify(reported.gates) ||
      JSON.stringify(c2zcRustAcceptance.verifyOutcome) !==
        JSON.stringify(reported.verifyOutcome)
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
    c2zcRestoreFixture: expectedFixtureEvidence,
  };
}

function verifyProductJourneyEvidence(
  receiptEvidence,
  currentEvidence,
  {
    candidate = null,
    expectedC2ZcAcceptance = null,
    currentC2ZcRestoreFixtureEvidence = null,
  } = {},
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
  if (
    expectedC2ZcAcceptance !== null &&
    receiptEvidence.acceptanceRequired !== expectedC2ZcAcceptance
  ) {
    throw new Error(
      "Full receipt C2-ZC acceptance requirement does not match the planned selection",
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
    if (expectedC2ZcAcceptance === true) {
      assertC2ZcRestoreFixtureEvidenceShape(
        receiptEvidence.c2zcRestoreFixture,
        "Full receipt C2-ZC restore fixture",
        { candidate },
      );
      const currentFixtureEvidence =
        currentC2ZcRestoreFixtureEvidence ??
        currentEvidence?.c2zcRestoreFixture;
      assertC2ZcRestoreFixtureEvidenceShape(
        currentFixtureEvidence,
        "Current C2-ZC restore fixture",
        { candidate },
      );
      assertC2ZcProductJourneyFixtureSummary(
        c2zcFixtureSummary(receiptEvidence.c2zcRestoreFixture),
        c2zcFixtureSummary(currentFixtureEvidence),
        "Full receipt C2-ZC fixture summary",
      );
    }
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
      "c2zcRestoreFixture",
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

function assertFullReceiptCommandArgs(
  receiptArgs,
  plannedArgs,
  { stageId, plan, candidate, label, runId },
) {
  if (!Array.isArray(receiptArgs) || !Array.isArray(plannedArgs)) {
    throw new Error(`${label} args must match the planned command.`);
  }
  if (receiptArgs.length !== plannedArgs.length) {
    throw new Error(`${label} args must match the planned command count.`);
  }
  for (const [index, plannedArg] of plannedArgs.entries()) {
    const option = index > 0 ? plannedArgs[index - 1] : null;
    const receiptArg = receiptArgs[index];
    if (
      typeof plannedArg === "string" &&
      plannedArg.includes("__LOCAL_CI_RUN_ID__")
    ) {
      const expectedArg =
        typeof runId === "string"
          ? plannedArg.replaceAll("__LOCAL_CI_RUN_ID__", runId)
          : plannedArg;
      if (receiptArg !== expectedArg) {
        throw new Error(
          `${label} run-specific path does not match the receipt.`,
        );
      }
      continue;
    }
    if (stageId === C2ZC_RESTORE_FIXTURE_STAGE) {
      if (
        option === "--repo-root" ||
        option === "--output-dir" ||
        option === "--manifest"
      ) {
        if (typeof receiptArg !== "string" || !path.isAbsolute(receiptArg)) {
          throw new Error(`${label} ${option} must be an absolute bound path.`);
        }
        continue;
      }
      if (option === "--candidate") {
        if (receiptArg !== plan.comparison?.head) {
          throw new Error(`${label} --candidate does not match the plan.`);
        }
        continue;
      }
      if (option === "--expected-head") {
        if (receiptArg !== candidate?.resolvedHeadSha) {
          throw new Error(
            `${label} --expected-head does not match the candidate.`,
          );
        }
        continue;
      }
      if (option === "--expected-tree") {
        if (receiptArg !== candidate?.resolvedHeadTreeSha) {
          throw new Error(
            `${label} --expected-tree does not match the candidate.`,
          );
        }
        continue;
      }
    }
    if (receiptArg !== plannedArg) {
      throw new Error(`${label} args do not match the planned command.`);
    }
  }
}

function assertFullReceiptCommandEnvironment(
  receiptEnv,
  plannedEnv,
  { stageId, plan, candidate, label, runId },
) {
  const actual = isPlainObject(receiptEnv) ? receiptEnv : {};
  const expected = isPlainObject(plannedEnv) ? { ...plannedEnv } : {};
  const runSpecificKeys = Object.entries(expected)
    .filter(
      ([, value]) =>
        typeof value === "string" && value.includes("__LOCAL_CI_RUN_ID__"),
    )
    .map(([key]) => key);
  if (runSpecificKeys.length > 0) {
    assertC2ZcRestoreFixtureRunId(runId, `${label} run`);
    for (const key of runSpecificKeys) {
      expected[key] = expected[key].replaceAll("__LOCAL_CI_RUN_ID__", runId);
    }
  }
  const isDynamicallyBoundStage =
    stageId === C2ZC_RUST_ACCEPTANCE_GATE_STAGE ||
    stageId === "electron-product-journeys";
  if (isDynamicallyBoundStage) {
    if (Object.hasOwn(expected, C2ZC_RUST_REQUESTED_BASE_ENV)) {
      expected[C2ZC_RUST_REQUESTED_BASE_ENV] = plan.comparison?.base;
    }
    if (Object.hasOwn(expected, C2ZC_RUST_REQUESTED_HEAD_ENV)) {
      expected[C2ZC_RUST_REQUESTED_HEAD_ENV] = plan.comparison?.head;
    }
  }
  if (
    stageId === C2ZC_RUST_ACCEPTANCE_GATE_STAGE &&
    Object.hasOwn(expected, C2ZC_RUST_RECEIPT_PATH_ENV)
  ) {
    expected[C2ZC_RUST_CANDIDATE_JSON_ENV] = JSON.stringify(candidate);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`${label} env does not match the planned command.`);
    }
  }
  const allowedDynamicKeys =
    stageId === "electron-product-journeys"
      ? new Set([
          C2ZC_RESTORE_FIXTURE_ENV,
          PRODUCT_JOURNEY_BUILD_RECEIPT_ENV,
          C2ZC_RUST_RECEIPT_SHA256_ENV,
        ])
      : new Set();
  for (const key of Object.keys(actual)) {
    if (!Object.hasOwn(expected, key) && !allowedDynamicKeys.has(key)) {
      throw new Error(`${label} env contains unplanned command values.`);
    }
  }
}

function commandOptionValue(command, option) {
  const args = Array.isArray(command?.args) ? command.args : [];
  const index = args.indexOf(option);
  return index === -1 ? null : args[index + 1];
}

function assertC2ZcFixtureReceiptPathCoherence(receiptStage, plannedStage) {
  const plannedOperations = plannedStage.commands.map((command) =>
    fixtureCommandOperation(command),
  );
  if (
    !plannedOperations.includes("build") &&
    !plannedOperations.includes("verify")
  ) {
    return;
  }
  const buildIndex = plannedOperations.indexOf("build");
  const verifyIndex = plannedOperations.indexOf("verify");
  if (buildIndex === -1 || verifyIndex === -1) {
    throw new Error(
      "Full receipt C2-ZC restore fixture stage must include build and verify commands.",
    );
  }
  const build = receiptStage.commands[buildIndex];
  const verify = receiptStage.commands[verifyIndex];
  const outputDir = commandOptionValue(build, "--output-dir");
  const manifestPath = commandOptionValue(verify, "--manifest");
  const buildRepoRoot = commandOptionValue(build, "--repo-root");
  const verifyRepoRoot = commandOptionValue(verify, "--repo-root");
  if (
    typeof outputDir !== "string" ||
    typeof manifestPath !== "string" ||
    path.dirname(manifestPath) !== outputDir ||
    path.basename(manifestPath) !== C2ZC_RESTORE_FIXTURE_MANIFEST_NAME ||
    buildRepoRoot !== verifyRepoRoot
  ) {
    throw new Error(
      "Full receipt C2-ZC restore fixture build and verify paths are not coherent.",
    );
  }
}

function assertFullReceiptStageBinding(receiptStages, plan, candidate, runId) {
  if (
    !isPlainObject(plan) ||
    plan.profile !== "full" ||
    !Array.isArray(plan.stages)
  ) {
    throw new Error(
      "Full receipt verification requires the complete Full CI plan.",
    );
  }
  if (!Array.isArray(receiptStages)) {
    throw new Error("Full receipt stage evidence is required.");
  }
  if (receiptStages.length !== plan.stages.length) {
    throw new Error(
      "Full receipt stages must contain exactly the planned stage count.",
    );
  }
  for (const [stageIndex, plannedStage] of plan.stages.entries()) {
    const receiptStage = receiptStages[stageIndex];
    if (
      !isPlainObject(plannedStage) ||
      typeof plannedStage.id !== "string" ||
      typeof plannedStage.label !== "string" ||
      !Array.isArray(plannedStage.commands)
    ) {
      throw new Error(
        `Full CI plan stage ${stageIndex} is not a valid command plan.`,
      );
    }
    if (
      !isPlainObject(receiptStage) ||
      receiptStage.id !== plannedStage.id ||
      receiptStage.label !== plannedStage.label
    ) {
      throw new Error(
        `Full receipt stage ${stageIndex} does not match the planned stage order.`,
      );
    }
    if (receiptStage.status !== "passed") {
      throw new Error(
        `Full receipt stage ${plannedStage.id} must have passed status.`,
      );
    }
    if (
      !Array.isArray(receiptStage.commands) ||
      receiptStage.commands.length !== plannedStage.commands.length
    ) {
      throw new Error(
        `Full receipt stage ${plannedStage.id} must contain exactly the planned command count.`,
      );
    }
    for (const [
      commandIndex,
      plannedCommand,
    ] of plannedStage.commands.entries()) {
      const receiptCommand = receiptStage.commands[commandIndex];
      if (
        !isPlainObject(plannedCommand) ||
        typeof plannedCommand.label !== "string" ||
        typeof plannedCommand.command !== "string" ||
        !isPlainObject(receiptCommand) ||
        receiptCommand.label !== plannedCommand.label ||
        receiptCommand.command !== plannedCommand.command
      ) {
        throw new Error(
          `Full receipt stage ${plannedStage.id} command ${commandIndex} does not match the planned command order.`,
        );
      }
      if (
        receiptCommand.status !== "passed" ||
        receiptCommand.exitCode !== 0 ||
        receiptCommand.signal !== null
      ) {
        throw new Error(
          `Full receipt stage ${plannedStage.id} command ${plannedCommand.label} must pass with exitCode 0 and no signal.`,
        );
      }
      const commandLabel = `Full receipt stage ${plannedStage.id} command ${plannedCommand.label}`;
      assertFullReceiptCommandArgs(receiptCommand.args, plannedCommand.args, {
        stageId: plannedStage.id,
        plan,
        candidate,
        label: commandLabel,
        runId,
      });
      if (receiptCommand.cwd !== plannedCommand.cwd) {
        throw new Error(
          `${commandLabel} cwd does not match the planned command.`,
        );
      }
      assertFullReceiptCommandEnvironment(
        receiptCommand.env,
        plannedCommand.env,
        {
          stageId: plannedStage.id,
          plan,
          candidate,
          label: commandLabel,
          runId,
        },
      );
    }
    if (plannedStage.id === C2ZC_RESTORE_FIXTURE_STAGE) {
      assertC2ZcFixtureReceiptPathCoherence(receiptStage, plannedStage);
    }
  }
}

function assertTaskLogIdentity(log, label, expectedPath = null) {
  if (
    !isPlainObject(log) ||
    typeof log.path !== "string" ||
    log.path.length === 0 ||
    path.isAbsolute(log.path) ||
    log.path.split(/[\\/]/u).includes("..") ||
    !Number.isSafeInteger(log.size) ||
    log.size < 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(log.sha256 ?? "")
  ) {
    throw new Error(`${label} is invalid`);
  }
  if (expectedPath !== null && log.path !== expectedPath) {
    throw new Error(`${label} does not match its run-specific path`);
  }
}

function assertExactTaskReceipt(receipt, plan, { required = false } = {}) {
  const hasTaskEvidence =
    receipt.tasks !== undefined || receipt.plan !== undefined;
  if (!required && !hasTaskEvidence) return;
  if (!Array.isArray(plan?.tasks)) {
    throw new Error("Local CI task receipt requires an exact task plan.");
  }
  assertC2ZcRestoreFixtureRunId(receipt.runId, "Local CI task receipt");
  if (
    receipt.registryDigest !== plan.registryDigest ||
    JSON.stringify(receipt.plan) !==
      JSON.stringify(createLocalCiPlanDescriptor(plan))
  ) {
    throw new Error("Local CI receipt does not match the exact task plan.");
  }
  if (
    !Array.isArray(receipt.tasks) ||
    receipt.tasks.length !== plan.tasks.length
  ) {
    throw new Error("Local CI receipt must contain every exact task result.");
  }
  for (const [index, task] of plan.tasks.entries()) {
    const result = receipt.tasks[index];
    if (
      !isPlainObject(result) ||
      result.id !== task.id ||
      result.status !== "passed" ||
      result.exitCode !== 0 ||
      result.signal !== null ||
      result.cleanup?.complete !== true ||
      result.interrupted === true ||
      result.timedOut === true ||
      result.error !== undefined
    ) {
      throw new Error(`Local CI task ${task.id} did not pass cleanly.`);
    }
    for (const stream of ["stdout", "stderr"]) {
      assertTaskLogIdentity(
        result.logs?.[stream],
        `Local CI task ${task.id} ${stream} log`,
        path.posix.join(
          ".artifacts",
          "local-ci",
          "runs",
          receipt.runId,
          "logs",
          `${task.id}.${stream}.log`,
        ),
      );
    }
  }
}

export async function verifyLocalCiTaskEvidence(
  receipt,
  { root = repoRoot } = {},
) {
  if (!Array.isArray(receipt?.tasks)) {
    throw new Error("Local CI task evidence is required.");
  }
  assertC2ZcRestoreFixtureRunId(receipt.runId, "Local CI task evidence");
  for (const task of receipt.tasks) {
    for (const stream of ["stdout", "stderr"]) {
      const expected = task.logs?.[stream];
      assertTaskLogIdentity(
        expected,
        `Local CI task ${task.id} ${stream} log`,
        path.posix.join(
          ".artifacts",
          "local-ci",
          "runs",
          receipt.runId,
          "logs",
          `${task.id}.${stream}.log`,
        ),
      );
      const current = await resolveArtifactEvidence(expected.path, { root });
      if (
        current.size !== expected.size ||
        current.sha256 !== expected.sha256
      ) {
        throw new Error(
          `Local CI task ${task.id} ${stream} log identity changed.`,
        );
      }
    }
  }
  return receipt;
}

export function verifyLocalCiReceipt(
  receipt,
  {
    profile,
    candidate,
    currentProductJourneyEvidence = null,
    currentC2ZcRestoreFixtureEvidence = null,
    plan = null,
    requireTaskEvidence = false,
  },
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
  if (
    profile === "full" &&
    (requireTaskEvidence || receipt.durationMs !== undefined) &&
    (!Number.isSafeInteger(receipt.durationMs) ||
      receipt.durationMs > LOCAL_CI_FULL_DEADLINE_MS)
  ) {
    throw new Error("Full local CI receipt exceeds 600000 ms.");
  }
  verifyCandidateBinding(receipt.candidate, candidate);
  const hasTaskEvidence =
    receipt.tasks !== undefined || receipt.plan !== undefined;
  if (
    (requireTaskEvidence || hasTaskEvidence) &&
    receipt.candidateAfter === undefined
  ) {
    throw new Error(
      "Local CI task receipt requires the post-run candidate binding.",
    );
  }
  if (receipt.candidateAfter !== undefined) {
    verifyCandidateBinding(receipt.candidateAfter, candidate);
    verifyCandidateBinding(receipt.candidate, receipt.candidateAfter);
  }
  if (receipt.deadlineExceeded === true) {
    throw new Error("Local CI receipt exceeded its execution deadline.");
  }
  assertExactTaskReceipt(receipt, plan, { required: requireTaskEvidence });
  if (profile === "full") {
    assertFullReceiptStageBinding(
      receipt.stages,
      plan,
      candidate,
      receipt.runId,
    );
    const expectedC2ZcAcceptance =
      plan?.profile === "full" ? expectedC2ZcAcceptanceForPlan(plan) : null;
    if (
      expectedC2ZcAcceptance === true &&
      receipt.productJourneyEvidence?.acceptanceRequired === true
    ) {
      assertC2ZcRestoreFixtureEvidenceShape(
        receipt.c2zcRestoreFixture,
        "Full receipt C2-ZC restore fixture",
        { candidate },
      );
      assertC2ZcRestoreFixtureRunBinding(
        receipt.c2zcRestoreFixture,
        receipt.runId,
        "Full receipt C2-ZC restore fixture",
      );
      assertC2ZcProductJourneyFixtureSummary(
        c2zcFixtureSummary(receipt.productJourneyEvidence.c2zcRestoreFixture),
        c2zcFixtureSummary(receipt.c2zcRestoreFixture),
        "Full receipt C2-ZC fixture summary",
      );
    }
    verifyProductJourneyEvidence(
      receipt.productJourneyEvidence,
      currentProductJourneyEvidence,
      {
        candidate,
        expectedC2ZcAcceptance,
        currentC2ZcRestoreFixtureEvidence,
      },
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

function executeCommand(
  entry,
  {
    logDirectory = ".artifacts/local-ci/logs",
    root = repoRoot,
    signal = null,
    taskId = entry.id ?? `command-${randomUUID()}`,
    timeoutMs = entry.timeoutMs,
  } = {},
) {
  return runLocalCiCommand(entry, {
    logDirectory,
    root,
    signal,
    taskId,
    timeoutMs,
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

function c2zcFixtureDiagnostic({
  runId,
  stage,
  command,
  operation,
  candidate,
  error,
}) {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  return {
    schema: C2ZC_RESTORE_FIXTURE_DIAGNOSTIC_VERSION,
    runId,
    stage,
    command: command.label,
    operation,
    candidate: candidate
      ? {
          requestedBase: candidate.requestedBase,
          requestedHead: candidate.requestedHead,
          resolvedBaseSha: candidate.resolvedBaseSha,
          resolvedHeadSha: candidate.resolvedHeadSha,
          resolvedHeadTreeSha: candidate.resolvedHeadTreeSha,
          currentHeadSha: candidate.currentHeadSha,
          worktreeClean: candidate.worktreeClean,
          worktreeFingerprint: candidate.worktreeFingerprint,
          worktreeStatusHash: candidate.worktreeStatusHash,
        }
      : null,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: message.slice(
        0,
        C2ZC_RESTORE_FIXTURE_DIAGNOSTIC_MAX_ERROR_LENGTH,
      ),
    },
  };
}

async function removeCopiedC2ZcRestoreFixture(root, runId) {
  await rm(c2zcRestoreFixtureEvidenceDirectory(root, runId), {
    recursive: true,
    force: true,
  });
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

export function assertC2ZcFullStageOrder(plan) {
  if (!isPlainObject(plan) || plan.profile !== "full") {
    throw new Error("C2-ZC stage order can only be verified for a Full plan");
  }
  assertC2ZcStageOrder(
    plan.stages?.map((stage) => stage?.id),
    "local CI Full plan C2-ZC stages",
  );
  return true;
}

/**
 * Acceptance is a property of the selected product journey catalog in the
 * plan, never a bit a receipt may set for itself.
 */
export function expectedC2ZcAcceptanceForPlan(plan) {
  assertC2ZcFullStageOrder(plan);
  const command = productJourneyCommandForPlan(plan);
  const catalog = productJourneyCatalogForCommand(command ?? { env: {} });
  return catalog.some((journey) => journey?.id === C2ZC_PRODUCT_JOURNEY_ID);
}

async function bindC2ZcProductJourneyCommand(
  command,
  stageId,
  {
    root,
    plan,
    candidate,
    buildStagePassed = false,
    restoreFixtureEvidence = null,
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
  if (isC2ZcSelection) {
    boundEnv[C2ZC_RESTORE_FIXTURE_ENV] = restoreFixtureEvidence
      ? JSON.stringify({
          path: path.resolve(root, restoreFixtureEvidence.path),
          manifest: path.resolve(root, restoreFixtureEvidence.manifestPath),
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
      [C2ZC_RUST_RECEIPT_SHA256_ENV]: receiptSha256,
    },
  };
}

function bindRunId(command, runId) {
  const replace = (value) => value.replaceAll("__LOCAL_CI_RUN_ID__", runId);
  return {
    ...command,
    args: command.args.map(replace),
    env: Object.fromEntries(
      Object.entries(command.env ?? {}).map(([key, value]) => [
        key,
        replace(value),
      ]),
    ),
  };
}

function executionPassed(execution) {
  return (
    execution.exitCode === 0 &&
    execution.signal == null &&
    execution.cleanup?.complete === true &&
    execution.interrupted !== true &&
    execution.timedOut !== true &&
    execution.error === undefined
  );
}

async function validateRunSpecificWebArtifact(command, { root, runId }) {
  const outputIndex = command.args.indexOf("--outDir");
  const expected = path.join(
    ".artifacts",
    "local-ci",
    "runs",
    runId,
    "web-editor",
  );
  if (outputIndex === -1 || command.args[outputIndex + 1] !== expected) {
    throw new Error(
      "Web Editor build must use its exact run-specific output path",
    );
  }
  await validateWebEditorArtifact(path.resolve(root, expected));
}

async function runConcurrentLocalCiPlan(
  plan,
  {
    candidate,
    deadlineMs,
    execute,
    logDirectory,
    notify,
    productJourneyEvidence,
    root,
    runId,
    signal,
  },
) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const completed = new Map();
  const commandRecords = new Map();
  let c2zcRestoreFixtureContext = null;
  let c2zcRestoreFixtureDiagnostic = null;
  let c2zcRestoreFixtureEvidenceOwned = false;

  const scheduled = await runLocalCiTasks(plan.tasks, {
    deadlineMs,
    maxSlots: plan.maxSlots,
    signal,
    notify(event) {
      if (event.type === "task-start") {
        notify({
          command: event.task.command,
          stage: { id: event.task.stageId, label: event.task.stageLabel },
          type: "command-start",
        });
      }
    },
    async executeTask(task, { signal }) {
      let command = task.command;
      const fixtureBinding = await bindC2ZcRestoreFixtureCommand(
        command,
        task.stageId,
        {
          root,
          plan,
          candidate,
          context: c2zcRestoreFixtureContext,
        },
      );
      c2zcRestoreFixtureContext = fixtureBinding.context;
      command = bindC2ZcRustGateCommand(command, task.stageId, {
        plan,
        candidate,
      });
      command = await bindC2ZcProductJourneyCommand(
        {
          ...command,
          ...(fixtureBinding.command === task.command
            ? {}
            : { args: fixtureBinding.command.args }),
        },
        task.stageId,
        {
          root,
          plan,
          candidate,
          restoreFixtureEvidence: c2zcRestoreFixtureContext?.evidence,
          buildStagePassed:
            completed.get("journeys.mcp-build")?.status === "passed",
        },
      );
      command = bindRunId(command, runId);

      let execution;
      try {
        execution = await execute(command, {
          logDirectory,
          root,
          signal,
          taskId: task.id,
          timeoutMs: task.timeoutMs,
        });
      } catch (error) {
        execution = {
          ...(isPlainObject(error?.result) ? error.result : {}),
          cleanup: error?.result?.cleanup ?? { complete: false },
          durationMs: error?.result?.durationMs ?? 0,
          error: error instanceof Error ? error.message : String(error),
          exitCode: error?.result?.exitCode ?? null,
          signal: error?.result?.signal ?? null,
        };
      }
      execution = {
        ...execution,
        cleanup: execution.cleanup ?? { complete: true },
      };

      if (executionPassed(execution) && task.id === "frontend.web-build") {
        try {
          await validateRunSpecificWebArtifact(command, { root, runId });
        } catch (error) {
          execution = {
            ...execution,
            error: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          };
        }
      }

      if (
        executionPassed(execution) &&
        task.stageId === C2ZC_RESTORE_FIXTURE_STAGE
      ) {
        try {
          const operation = fixtureCommandOperation(command);
          await validateC2ZcRestoreFixtureContext(c2zcRestoreFixtureContext);
          if (operation === "verify") {
            c2zcRestoreFixtureContext.evidence =
              await captureC2ZcRestoreFixtureEvidence(
                c2zcRestoreFixtureContext,
                root,
                { runId },
              );
            c2zcRestoreFixtureEvidenceOwned = true;
          }
        } catch (error) {
          execution = {
            ...execution,
            error: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          };
        }
      }
      const status = executionPassed(execution) ? "passed" : "failed";
      if (task.stageId === C2ZC_RESTORE_FIXTURE_STAGE && status === "failed") {
        if (c2zcRestoreFixtureEvidenceOwned) {
          await removeCopiedC2ZcRestoreFixture(root, runId);
          c2zcRestoreFixtureEvidenceOwned = false;
        }
        c2zcRestoreFixtureDiagnostic = c2zcFixtureDiagnostic({
          runId,
          stage: task.stageId,
          command,
          operation: fixtureCommandOperation(command),
          candidate,
          error: execution.error ?? "C2-ZC fixture command failed",
        });
      }
      completed.set(task.id, { status });
      commandRecords.set(task.id, { command, execution });
      notify({
        command,
        execution,
        stage: { id: task.stageId, label: task.stageLabel },
        status,
        type: "command-end",
      });
      return execution;
    },
  });

  if (c2zcRestoreFixtureContext?.outputDir) {
    await rm(c2zcRestoreFixtureContext.outputDir, {
      recursive: true,
      force: true,
    });
    c2zcRestoreFixtureContext.outputDir = null;
  }

  const taskResults = new Map(
    scheduled.tasks.map((result) => [result.id, result]),
  );
  const stages = plan.stages.map((stage) => {
    const commands = stage.commands.map((planned) => {
      const result = taskResults.get(planned.id);
      const record = commandRecords.get(planned.id);
      return {
        ...(record?.command ?? planned),
        ...result,
      };
    });
    const status = commands.some((command) => command.status === "failed")
      ? "failed"
      : commands.every((command) => command.status === "passed")
        ? "passed"
        : "not-run";
    return {
      id: stage.id,
      label: stage.label,
      status,
      durationMs: commands.reduce(
        (total, command) => total + (command.durationMs ?? 0),
        0,
      ),
      commands,
    };
  });

  return {
    version: LOCAL_CI_RECEIPT_VERSION,
    profile: plan.profile,
    comparison: plan.comparison,
    coverage: plan.coverage,
    candidate,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    status: scheduled.status,
    deadlineExceeded: scheduled.deadlineExceeded,
    interrupted: scheduled.interrupted,
    registryDigest: plan.registryDigest,
    plan: createLocalCiPlanDescriptor(plan),
    tasks: scheduled.tasks,
    c2zcRestoreFixture: c2zcRestoreFixtureContext?.evidence ?? null,
    c2zcRestoreFixtureDiagnostic,
    productJourneyEvidence,
    releaseOnlyJobs: plan.releaseOnlyJobs,
    stages,
  };
}

export async function runLocalCiPlan(
  plan,
  {
    candidate = null,
    dryRun = false,
    executeCommand: execute = (entry, options) =>
      executeCommand(entry, options),
    notify = () => {},
    productJourneyEvidence = null,
    root = repoRoot,
    runId: requestedRunId = null,
    concurrent = false,
    deadlineMs = Number.POSITIVE_INFINITY,
    logDirectory = null,
    signal = null,
  } = {},
) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const runId = requestedRunId ?? randomUUID();
  assertC2ZcRestoreFixtureRunId(runId, "Local CI run");
  if (concurrent && !dryRun) {
    return runConcurrentLocalCiPlan(plan, {
      candidate,
      deadlineMs,
      execute,
      logDirectory: logDirectory ?? `.artifacts/local-ci/runs/${runId}/logs`,
      notify,
      productJourneyEvidence,
      root,
      runId,
      signal,
    });
  }
  const stages = [];
  let failedStage = null;
  let c2zcRestoreFixtureContext = null;
  let c2zcRestoreFixtureDiagnostic = null;
  let c2zcRestoreFixtureEvidenceOwned = false;

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
          restoreFixtureEvidence: c2zcRestoreFixtureContext?.evidence,
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
                { runId },
              );
            c2zcRestoreFixtureEvidenceOwned = true;
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
      if (stage.id === C2ZC_RESTORE_FIXTURE_STAGE && status === "failed") {
        if (c2zcRestoreFixtureEvidenceOwned) {
          await removeCopiedC2ZcRestoreFixture(root, runId);
          c2zcRestoreFixtureEvidenceOwned = false;
        }
        c2zcRestoreFixtureDiagnostic = c2zcFixtureDiagnostic({
          runId,
          stage: stage.id,
          command: boundCommand,
          operation: fixtureCommandOperation(boundCommand),
          candidate,
          error: execution.error ?? "C2-ZC fixture command failed",
        });
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
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    status: dryRun ? "planned" : failedStage ? "failed" : "passed",
    c2zcRestoreFixture: c2zcRestoreFixtureContext?.evidence ?? null,
    c2zcRestoreFixtureDiagnostic,
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
        if (
          !["--outDir", "--output", "--report"].includes(command.args[index])
        ) {
          continue;
        }
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
  const temporaryPath = path.join(
    path.dirname(reportPath),
    `.${path.basename(reportPath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporaryPath, reportPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function acquireCheckoutLock(root) {
  const lockPath = path.join(root, ".artifacts", "local-ci", "checkout.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Local CI checkout lock already exists; inspect and remove it manually if no run is active: ${lockPath}`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid })}\n`,
    );
  } catch (error) {
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }
  return { handle, path: lockPath };
}

async function releaseCheckoutLock(lock) {
  if (!lock) return;
  await lock.handle.close();
  await rm(lock.path);
}

function remainingFullWallTime(profile, started) {
  if (profile !== "full") return Number.POSITIVE_INFINITY;
  return LOCAL_CI_FULL_DEADLINE_MS - (performance.now() - started);
}

async function runExternalVerifier({ args, reportPath, signal, timeoutMs }) {
  const verifierArgs = [
    fileURLToPath(import.meta.url),
    args.profile,
    "--verify",
    "--base",
    args.base,
    "--head",
    args.head,
    "--report",
    reportPath,
  ];
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    verifierArgs,
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      signal,
      timeout: Number.isFinite(timeoutMs)
        ? Math.max(1, Math.floor(timeoutMs))
        : 120_000,
    },
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

async function main() {
  const invocationStarted = performance.now();
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
  args.base ??= registry.defaultBase;
  args.head ??= "HEAD";
  const plan = buildLocalCiPlan(registry, {
    profile: args.profile,
    base: args.base,
    head: args.head,
    from: args.from,
  });
  process.stdout.write(
    `[local-ci] profile=${plan.profile} base=${plan.comparison.base} head=${plan.comparison.head}\n`,
  );
  for (const job of plan.releaseOnlyJobs) {
    process.stdout.write(`[local-ci] release-only ${job.id}: ${job.reason}\n`);
  }
  const reportPath = path.resolve(
    repoRoot,
    args.report ?? `.artifacts/local-ci/${plan.profile}.json`,
  );
  if (args.verify) {
    if (args.dryRun) {
      throw new Error("--verify cannot be combined with --dry-run");
    }
    const candidate = validateLocalCiCandidate(
      plan,
      await resolveLocalCiCandidate(plan),
    );
    const receipt = JSON.parse(await readFile(reportPath, "utf8"));
    const currentProductJourneyEvidence =
      plan.profile === "full"
        ? await collectProductJourneyEvidence(plan, {
            candidate,
            restoreFixtureEvidence: receipt.c2zcRestoreFixture,
            runId: receipt.runId,
          })
        : null;
    verifyLocalCiReceipt(receipt, {
      profile: plan.profile,
      candidate,
      plan,
      currentProductJourneyEvidence,
      currentC2ZcRestoreFixtureEvidence:
        currentProductJourneyEvidence?.c2zcRestoreFixture ?? null,
      requireTaskEvidence: true,
    });
    await verifyLocalCiTaskEvidence(receipt, { root: repoRoot });
    process.stdout.write(`[local-ci] verified=${reportPath}\n`);
    return;
  }
  const notify = (event) => {
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
      if (event.status === "failed") {
        if (event.execution?.error) {
          process.stderr.write(`[local-ci] error=${event.execution.error}\n`);
        }
        for (const stream of ["stderr", "stdout"]) {
          const logPath = event.execution?.logs?.[stream]?.path;
          if (logPath)
            process.stderr.write(`[local-ci] ${stream}=${logPath}\n`);
        }
      }
    }
  };
  if (args.dryRun) {
    const result = await runLocalCiPlan(plan, {
      dryRun: true,
      notify,
      root: repoRoot,
    });
    process.stdout.write(`[local-ci] status=${result.status}\n`);
    return;
  }

  const cliAbort = new AbortController();
  const interrupt = (signalName) => {
    if (!cliAbort.signal.aborted) {
      cliAbort.abort(new Error(`Local CI interrupted by ${signalName}.`));
    }
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  let checkoutLock = null;
  let result = null;
  let stagingReceiptPath = null;
  try {
    checkoutLock = await acquireCheckoutLock(repoRoot);
    if (cliAbort.signal.aborted) throw cliAbort.signal.reason;
    const candidate = validateLocalCiCandidate(
      plan,
      await resolveLocalCiCandidate(plan),
    );
    await prepareLocalCiArtifacts(plan);
    const remainingBeforeTasks = remainingFullWallTime(
      plan.profile,
      invocationStarted,
    );
    if (remainingBeforeTasks <= 0) {
      throw new Error(
        "Full local CI exceeded 600000 ms before task admission.",
      );
    }
    const runId = randomUUID();
    result = await runLocalCiPlan(plan, {
      candidate,
      concurrent: true,
      deadlineMs: remainingBeforeTasks,
      notify,
      root: repoRoot,
      runId,
      signal: cliAbort.signal,
    });
    const finishedCandidate = validateLocalCiCandidate(
      plan,
      await resolveLocalCiCandidate(plan),
    );
    result.candidateAfter = finishedCandidate;
    try {
      verifyCandidateBinding(result.candidate, finishedCandidate);
      if (plan.profile === "full" && result.status === "passed") {
        result.productJourneyEvidence = await collectProductJourneyEvidence(
          plan,
          {
            candidate: finishedCandidate,
            restoreFixtureEvidence: result.c2zcRestoreFixture,
            runId: result.runId,
          },
        );
      }
      if (cliAbort.signal.aborted) throw cliAbort.signal.reason;
      result.durationMs = Math.round(performance.now() - invocationStarted);
      if (
        plan.profile === "full" &&
        result.durationMs > LOCAL_CI_FULL_DEADLINE_MS
      ) {
        throw new Error(
          "Full local CI exceeded 600000 ms before verification.",
        );
      }
      if (
        result.status === "passed" &&
        plan.coverage.completeness === "complete"
      ) {
        verifyLocalCiReceipt(result, {
          profile: plan.profile,
          candidate: finishedCandidate,
          plan,
          currentProductJourneyEvidence: result.productJourneyEvidence,
          currentC2ZcRestoreFixtureEvidence:
            result.productJourneyEvidence?.c2zcRestoreFixture ?? null,
          requireTaskEvidence: true,
        });
        await verifyLocalCiTaskEvidence(result, { root: repoRoot });
      }
    } catch (error) {
      result.status = "failed";
      result.receiptError =
        error instanceof Error ? error.message : String(error);
    }
    if (
      result.status === "passed" &&
      plan.coverage.completeness === "complete"
    ) {
      stagingReceiptPath = path.join(
        path.dirname(reportPath),
        `.${path.basename(reportPath)}.${result.runId}.staging`,
      );
      await writeReport(stagingReceiptPath, result);
      const remainingBeforeVerify = remainingFullWallTime(
        plan.profile,
        invocationStarted,
      );
      if (remainingBeforeVerify <= 0) {
        throw new Error(
          "Full local CI exceeded 600000 ms before verification.",
        );
      }
      await runExternalVerifier({
        args,
        reportPath: stagingReceiptPath,
        signal: cliAbort.signal,
        timeoutMs: remainingBeforeVerify,
      });
      if (cliAbort.signal.aborted) throw cliAbort.signal.reason;
      if (remainingFullWallTime(plan.profile, invocationStarted) < 0) {
        throw new Error(
          "Full local CI exceeded 600000 ms during verification.",
        );
      }
      await mkdir(path.dirname(reportPath), { recursive: true });
      await rename(stagingReceiptPath, reportPath);
      stagingReceiptPath = null;
      if (remainingFullWallTime(plan.profile, invocationStarted) < 0) {
        await rm(reportPath, { force: true });
        throw new Error(
          "Full local CI exceeded 600000 ms while publishing verification.",
        );
      }
    } else {
      await writeReport(reportPath, result);
    }
    process.stdout.write(`[local-ci] report=${reportPath}\n`);
  } catch (error) {
    if (stagingReceiptPath) await rm(stagingReceiptPath, { force: true });
    throw error;
  } finally {
    try {
      await releaseCheckoutLock(checkoutLock);
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  }
  process.stdout.write(`[local-ci] status=${result?.status ?? "failed"}\n`);
  if (result?.status !== "passed") process.exitCode = 1;
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
