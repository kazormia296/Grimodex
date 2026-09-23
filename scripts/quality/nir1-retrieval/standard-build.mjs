import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./contract.mjs";
import { runLocalCiCommand } from "../../local-ci-process-supervisor.mjs";

const BASE_REF = "refs/remotes/origin/master";
const COMMANDS = [
  { command: "pnpm", args: ["napi:build"] },
  { command: "pnpm", args: ["electron:build"] },
];
const REQUIRED_ARTIFACTS = [
  "dist/index.html",
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "electron/native/grimodex-node/grimodex-node.node",
];
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 2_000;
const CLOSE_GRACE_MS = 2_000;
const SHA256 = /^[0-9a-f]{64}$/u;

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function requireRepoRelative(file) {
  assert.ok(
    file && !path.isAbsolute(file) && !file.split("/").includes(".."),
    `invalid repo-relative source path: ${file}`,
  );
  return file;
}

function sourcePaths(root, head) {
  const paths = git(
    root,
    ["ls-tree", "-r", "--name-only", "-z", head],
    "buffer",
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(requireRepoRelative)
    .sort();
  assert.ok(paths.length > 0, "source manifest cannot be empty");
  assert.equal(new Set(paths).size, paths.length, "duplicate source path");
  return paths;
}

async function sourceDigests(root, paths) {
  const entries = {};
  for (const file of paths)
    entries[file] = sha256(await readFile(path.join(root, file)));
  return entries;
}

function assertDigestMap(value, paths) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value), paths);
  for (const digest of Object.values(value)) assert.match(digest, SHA256);
}

function cleanStatus(root) {
  const indexEntries = git(root, ["ls-files", "-v", "-z"], "buffer")
    .toString("utf8")
    .split("\0");
  assert.ok(
    !indexEntries.some((entry) => /^[a-zS] /u.test(entry)),
    "source index must not use assume-unchanged or skip-worktree flags",
  );
  return git(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "buffer",
  );
}

function captureCandidate(root) {
  const resolvedBaseSha = git(root, [
    "rev-parse",
    "--verify",
    `${BASE_REF}^{commit}`,
  ])
    .trim()
    .toLowerCase();
  const resolvedHeadSha = git(root, ["rev-parse", "--verify", "HEAD^{commit}"])
    .trim()
    .toLowerCase();
  const resolvedHeadTreeSha = git(root, [
    "rev-parse",
    "--verify",
    `${resolvedHeadSha}^{tree}`,
  ])
    .trim()
    .toLowerCase();
  git(root, ["merge-base", "--is-ancestor", resolvedBaseSha, resolvedHeadSha]);
  return {
    requestedBase: BASE_REF,
    requestedHead: "HEAD",
    resolvedBaseSha,
    resolvedHeadSha,
    resolvedHeadTreeSha,
    currentHeadSha: resolvedHeadSha,
  };
}

function sameCandidate(left, right) {
  return [
    "requestedBase",
    "requestedHead",
    "resolvedBaseSha",
    "resolvedHeadSha",
    "resolvedHeadTreeSha",
    "currentHeadSha",
  ].every((field) => left[field] === right[field]);
}

function insideRoot(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function assertReceiptLocation(root, receiptPath) {
  assert.ok(path.isAbsolute(receiptPath), "receipt path must be absolute");
  if (!insideRoot(root, receiptPath)) return;
  const relative = path.relative(root, receiptPath);
  assert.ok(
    relative === ".artifacts" || relative.startsWith(`.artifacts${path.sep}`),
    "receipt inside the repository must be under ignored .artifacts/",
  );
}

async function assertAbsent(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing output: ${file}`);
}

async function writeExclusiveJson(file, value) {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishNoReplace(file, value, attemptId, signal = null) {
  const temporary = `${file}.tmp-${attemptId}`;
  await writeExclusiveJson(temporary, value);
  try {
    const bytes = await readFile(temporary);
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), value);
    if (signal?.aborted)
      throw (
        signal.reason ??
        new Error("producer interrupted before receipt publication")
      );
    linkSync(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function persistOwner(ownerPath, owner) {
  await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

function commandRecord(entry, result, error = null) {
  const observed = result ?? error?.result ?? null;
  const status = !observed
    ? "not-started"
    : observed.closeObserved === false
      ? "termination-unknown"
      : observed.interrupted
        ? "interrupted"
        : observed.timedOut
          ? "timed-out"
          : observed.error
            ? "spawn-error"
            : observed.exitCode === 0 &&
                observed.signal === null &&
                observed.cleanup?.complete === true &&
                observed.termination === "close-and-group-exit-observed"
              ? "passed"
              : "failed";
  return {
    argv: [entry.command, ...entry.args],
    status,
    exitCode: observed?.exitCode ?? null,
    signal: observed?.signal ?? null,
    closeObserved: observed?.closeObserved === true,
    processGroupId: observed?.processGroupId ?? observed?.pid ?? null,
    termination: observed?.termination ?? "not-started",
    cleanup: observed?.cleanup ?? null,
    logs: observed?.logs ?? null,
    ...(observed?.error ? { error: observed.error } : {}),
    ...(error && !observed ? { error: error.message } : {}),
  };
}

async function artifactDigests(root) {
  const artifacts = {};
  for (const file of REQUIRED_ARTIFACTS) {
    const fullPath = path.join(root, file);
    const metadata = await lstat(fullPath);
    assert.ok(
      metadata.isFile() && metadata.size > 0,
      `required artifact must be regular and nonempty: ${file}`,
    );
    artifacts[file] = sha256(await readFile(fullPath));
  }
  return artifacts;
}

function validateSuccessReceipt(receipt, fixture) {
  assert.equal(
    receipt.schemaVersion,
    fixture ? "nir1-standard-build-fixture/1" : "nir1-standard-build/1",
  );
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.standardBuild, !fixture);
  assert.equal(receipt.sourceUnchanged, true);
  assert.ok(path.isAbsolute(receipt.root));
  assert.ok(receipt.candidate?.worktreeClean === true);
  for (const field of [
    "resolvedBaseSha",
    "resolvedHeadSha",
    "resolvedHeadTreeSha",
  ])
    assert.match(receipt.candidate[field], /^[0-9a-f]{40,64}$/u);
  assert.equal(
    receipt.candidate.currentHeadSha,
    receipt.candidate.resolvedHeadSha,
  );
  assert.ok(path.isAbsolute(receipt.sourceManifest));
  assert.match(receipt.sourceManifestSha256, SHA256);
  assert.deepEqual(
    receipt.commands.map(({ argv, exitCode }) => ({ argv, exitCode })),
    [
      { argv: ["pnpm", "napi:build"], exitCode: 0 },
      { argv: ["pnpm", "electron:build"], exitCode: 0 },
    ],
  );
  assert.ok(
    receipt.commands.every(
      (command) =>
        command.status === "passed" &&
        command.closeObserved === true &&
        command.termination === "close-and-group-exit-observed" &&
        command.cleanup?.complete === true,
    ),
  );
  assert.deepEqual(Object.keys(receipt.artifacts), REQUIRED_ARTIFACTS);
  for (const digest of Object.values(receipt.artifacts))
    assert.match(digest, SHA256);
}

export async function produceStandardBuildReceipt({
  root,
  receiptPath,
  signal = null,
  ...extra
}) {
  assert.deepEqual(
    Object.keys(extra),
    [],
    "unsupported standard-build producer option",
  );
  return produceBuildReceipt({ root, receiptPath, signal });
}

// Injected fixture runners can never produce authoritative standard-build evidence.
export async function produceStandardBuildFixtureReceipt(options) {
  return produceBuildReceipt({ ...options, fixture: true });
}

async function produceBuildReceipt({
  root: requestedRoot,
  receiptPath: requestedReceiptPath,
  signal = null,
  fixture = false,
  runCommand = runLocalCiCommand,
  writeOwner = persistOwner,
  timeoutMs = COMMAND_TIMEOUT_MS,
  termGraceMs = TERMINATION_GRACE_MS,
  killGraceMs = TERMINATION_GRACE_MS,
  closeGraceMs = CLOSE_GRACE_MS,
}) {
  assert.ok(path.isAbsolute(requestedRoot), "root must be absolute");
  const root = await realpath(requestedRoot);
  const repositoryRoot = await realpath(
    git(root, ["rev-parse", "--show-toplevel"]).trim(),
  );
  assert.equal(
    repositoryRoot,
    root,
    "root must be the canonical Git worktree root",
  );

  assert.ok(
    typeof requestedReceiptPath === "string" &&
      path.isAbsolute(requestedReceiptPath),
    "receipt path must be absolute",
  );
  const receiptPath = path.resolve(requestedReceiptPath);
  assertReceiptLocation(root, receiptPath);
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await assertAbsent(receiptPath);

  const attemptId = randomUUID();
  const lockDirectory = path.join(
    root,
    ".artifacts/nir1-standard-build/active",
  );
  const ownerPath = path.join(lockDirectory, "owner.json");
  await mkdir(path.dirname(lockDirectory), { recursive: true });
  await mkdir(lockDirectory);

  let releaseLock = true;
  let unresolvedOwner = false;
  const logDirectory = path.join(
    root,
    ".artifacts/nir1-standard-build/runs",
    attemptId,
  );
  const sourceManifest = `${receiptPath}.sources.json`;
  const commands = [];
  let candidate = null;
  let sourceUnchanged = false;
  let sourceManifestSha256 = null;
  let pendingLateClose = null;
  let artifacts = {};
  const startedAt = new Date().toISOString();
  const owner = {
    schemaVersion: "nir1-standard-build-owner/1",
    attemptId,
    pid: process.pid,
    root,
    receiptPath,
    status: "running",
    phase: "precheck",
    startedAt,
    commands,
  };

  const schemaVersion = fixture
    ? "nir1-standard-build-fixture/1"
    : "nir1-standard-build/1";
  const failureReceipt = (stage, error) => ({
    schemaVersion,
    attemptId,
    root,
    ...(candidate ? { candidate } : {}),
    status: "failed",
    standardBuild: false,
    sourceUnchanged,
    commands,
    ...(sourceManifestSha256 ? { sourceManifest, sourceManifestSha256 } : {}),
    failure: { stage, message: error?.message ?? String(error) },
    startedAt,
    finishedAt: new Date().toISOString(),
  });

  await writeExclusiveJson(ownerPath, owner);
  try {
    await assertAbsent(sourceManifest);
    if (signal?.aborted)
      throw signal.reason ?? new Error("producer interrupted before admission");

    const statusBefore = cleanStatus(root);
    candidate = {
      ...captureCandidate(root),
      worktreeClean: statusBefore.length === 0,
    };
    if (!candidate.worktreeClean) {
      throw new Error("source candidate must be clean before build admission");
    }
    const pathsBefore = sourcePaths(root, candidate.resolvedHeadSha);
    const entriesBefore = await sourceDigests(root, pathsBefore);
    const manifestBytes = Buffer.from(
      `${JSON.stringify(entriesBefore, null, 2)}\n`,
    );
    sourceManifestSha256 = sha256(manifestBytes);
    const manifestHandle = await open(sourceManifest, "wx");
    try {
      await manifestHandle.writeFile(manifestBytes);
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    assert.equal(sha256(await readFile(sourceManifest)), sourceManifestSha256);
    assertDigestMap(
      JSON.parse(await readFile(sourceManifest, "utf8")),
      pathsBefore,
    );

    const beforeAdmission = captureCandidate(root);
    assert.deepEqual(
      cleanStatus(root),
      Buffer.alloc(0),
      "source became dirty before build admission",
    );
    assert.ok(
      sameCandidate(candidate, beforeAdmission),
      "candidate identity changed before build admission",
    );
    owner.candidate = candidate;
    owner.sourceManifest = sourceManifest;
    owner.sourceManifestSha256 = sourceManifestSha256;
    owner.phase = "building";
    await writeOwner(ownerPath, owner);

    for (const entry of COMMANDS) {
      if (signal?.aborted)
        throw (
          signal.reason ?? new Error("producer interrupted before next command")
        );
      let result;
      try {
        result = await runCommand(
          { command: entry.command, args: [...entry.args], cwd: "." },
          {
            root,
            logDirectory: path.relative(root, logDirectory),
            signal,
            taskId: entry.args[0].replaceAll(":", "-"),
            timeoutMs,
            termGraceMs,
            killGraceMs,
            closeGraceMs,
          },
        );
      } catch (error) {
        const record = commandRecord(entry, null, error);
        commands.push(record);
        owner.commands = commands;
        owner.phase = "command-failed";
        owner.status = "failed";
        if (error?.lateClose) {
          unresolvedOwner = true;
          pendingLateClose = error.lateClose;
          // Observe rejection immediately, while retaining it for the awaited cleanup path.
          pendingLateClose.catch(() => {});
        }
        await writeOwner(ownerPath, owner);
        throw error;
      }
      const record = commandRecord(entry, result);
      commands.push(record);
      owner.commands = commands;
      await writeOwner(ownerPath, owner);
      if (record.status !== "passed") {
        const error = signal?.aborted
          ? (signal.reason ?? new Error("producer interrupted"))
          : new Error(
              `standard build command did not complete cleanly: ${entry.command} ${entry.args.join(" ")}`,
            );
        error.stage = "command";
        throw error;
      }
    }

    if (signal?.aborted)
      throw (
        signal.reason ??
        new Error("producer interrupted before source verification")
      );
    const statusAfter = cleanStatus(root);
    const candidateAfter = captureCandidate(root);
    const pathsAfter = sourcePaths(root, candidateAfter.resolvedHeadSha);
    assert.deepEqual(
      pathsAfter,
      pathsBefore,
      "source path list changed during build",
    );
    const entriesAfter = await sourceDigests(root, pathsAfter);
    assert.deepEqual(
      entriesAfter,
      entriesBefore,
      "source file hashes changed during build",
    );
    assert.deepEqual(
      statusAfter,
      Buffer.alloc(0),
      "source candidate became dirty during build",
    );
    assert.ok(
      sameCandidate(candidate, candidateAfter),
      "base, HEAD, or tree changed during build",
    );
    assert.equal(sha256(await readFile(sourceManifest)), sourceManifestSha256);
    const storedManifest = JSON.parse(await readFile(sourceManifest, "utf8"));
    assertDigestMap(storedManifest, pathsBefore);
    assert.deepEqual(storedManifest, entriesBefore);
    sourceUnchanged = true;
    artifacts = await artifactDigests(root);

    for (const [file, digest] of Object.entries(artifacts)) {
      const metadata = await lstat(path.join(root, file));
      assert.ok(metadata.isFile() && metadata.size > 0);
      assert.equal(sha256(await readFile(path.join(root, file))), digest);
    }

    const receipt = {
      schemaVersion,
      attemptId,
      root,
      candidate,
      status: "passed",
      standardBuild: !fixture,
      sourceUnchanged: true,
      commands,
      sourceManifest,
      sourceManifestSha256,
      artifacts,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    validateSuccessReceipt(receipt, fixture);
    const manifestBytesAfter = await readFile(sourceManifest);
    assert.equal(sha256(manifestBytesAfter), sourceManifestSha256);
    const manifestForReceipt = JSON.parse(manifestBytesAfter.toString("utf8"));
    assertDigestMap(manifestForReceipt, pathsBefore);
    assert.deepEqual(manifestForReceipt, entriesBefore);
    if (signal?.aborted)
      throw (
        signal.reason ??
        new Error("producer interrupted before receipt publication")
      );
    await writeOwner(ownerPath, {
      ...owner,
      status: "publishing",
      phase: "validated",
    });
    if (signal?.aborted)
      throw (
        signal.reason ??
        new Error("producer interrupted before receipt publication")
      );
    await publishNoReplace(receiptPath, receipt, attemptId, signal);
    return { receiptPath, receipt };
  } catch (error) {
    const failed = failureReceipt(error?.stage ?? "producer", error);
    owner.status = "failed";
    owner.phase =
      unresolvedOwner ||
      error?.result?.closeObserved === false ||
      error?.result?.cleanup?.complete === false
        ? "termination-unknown"
        : "failed";
    owner.failure = failed.failure;
    owner.commands = commands;
    try {
      await writeOwner(ownerPath, owner);
      await publishNoReplace(receiptPath, failed, attemptId);
    } catch (outputError) {
      releaseLock = false;
      owner.outputError = outputError.message;
      await writeOwner(ownerPath, owner).catch(() => {});
      error.outputError = outputError;
    }
    if (unresolvedOwner && pendingLateClose) {
      // Keep this process and the root lock alive until the original owner proves quiescence.
      try {
        const late = await pendingLateClose;
        const lastCommand = commands.at(-1);
        if (lastCommand) {
          lastCommand.lateResolution = late.termination;
          lastCommand.lateExitCode = late.exitCode;
          lastCommand.lateSignal = late.signal;
        }
        await writeOwner(ownerPath, {
          ...owner,
          phase: "late-cleanup-observed",
        });
        unresolvedOwner = false;
      } catch (lateError) {
        releaseLock = false;
        owner.lateCleanupError = lateError.message;
        await writeOwner(ownerPath, owner).catch(() => {});
      }
    }
    if (!releaseLock) throw error;
    throw Object.assign(error, { receiptPath, failureReceipt: failed });
  } finally {
    if (releaseLock && !unresolvedOwner)
      await rm(lockDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const [output, ...extra] = process.argv.slice(2);
  assert.ok(
    output && path.isAbsolute(output) && extra.length === 0,
    "usage: node scripts/quality/nir1-retrieval/standard-build.mjs <new absolute receipt path>",
  );
  const root = await realpath(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );
  const controller = new AbortController();
  let receivedSignal = null;
  const onSignal = (signalName) => {
    receivedSignal ??= signalName;
    controller.abort(new Error(`received ${signalName}`));
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const result = await produceStandardBuildReceipt({
      root,
      receiptPath: output,
      signal: controller.signal,
    });
    process.stdout.write(`Standard build receipt: ${result.receiptPath}\n`);
  } catch (error) {
    process.stderr.write(
      `[artifact] standard build receipt failed: ${error.message}\n`,
    );
    process.exitCode =
      receivedSignal === "SIGINT"
        ? 130
        : receivedSignal === "SIGTERM"
          ? 143
          : 1;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `[artifact] standard build receipt failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
