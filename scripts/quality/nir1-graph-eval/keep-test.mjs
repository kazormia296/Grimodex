// CP-4 S1f: 批准 5 の (b) の keep test の collector の実行部（DR-CP4-H-21 の続き、
// DR-CP4-F-4）。
//
// K6/4:32 の (b) の証拠の 1 つは「候補で RS-JOIN の keep test
// （`useNir1RelatedScenes.graphReadyKeep.test.tsx`）が通ったこと」である。S1e は
// 呼出し側の書いた試験の receipt を読む経路を閉じた（誰でも `passed: true` と書け
// る）。ここでは collector 自身が、候補の commit を HEAD に持つ clean な worktree
// で vitest を走らせ、JSON reporter の報告を機械的に読む。
//
// 次のどれも `refused`（admission.mjs はその場合 (b) を hook の commit の祖先だけで
// 判定し、この repository の候補は K6/2 の regime になる＝fail closed）:
// worktree が git の worktree の top level でない、HEAD が候補と違う、clean でない
// （ignore されない未追跡の file を含む）、試験 file が候補に無いか worktree と違う、
// runner が起動できない・時間内に終わらない・0 以外で終わる、報告が読めない・別の
// file のもの・0 件・pass でない件がある、実行の後に worktree が変わった。
//
// レビュー P2-4: (a) install 済みの `node_modules/.pnpm/lock.yaml` が候補の
// `pnpm-lock.yaml` と byte で同じで、`node_modules/vitest` が worktree の
// `node_modules` の中にあり、その版が候補の lock の root importer の vitest の版と
// 同じであること（違えば走らせない。依存の導入は呼ばない）。走った証拠には lock の
// sha256 と vitest の版を残す。(b) runner の env は最小の allowlist
// （`NODE_OPTIONS`、`VITEST_*`、表示・D-Bus・proxy の変数を渡さない）。(c) stdout と
// stderr の末尾を残す（`logDir` があれば file にも）。(d) runner は自分の process
// group（`detached: true`）で async に走らせ、timeout では group ごと SIGKILL で止
// める。SIGTERM／SIGINT の handler（signal-cleanup.mjs）は spawn の前に置き、生き
// ている group をその対象に登録する。runner の終了の後に group に残った process
// （孫）は止めて `runner-left-processes` で refused にする。
//
// この module は結果を封印しない。封印は admission.mjs の
// `collectRatification5Evidence` だけが行う（sealer は admission.mjs が load の時に
// 一度だけ取る。admission-facts.mjs）。試験専用の封印（test-support の
// `claimTestEvidenceSealer`）は本番の入口から呼べないまま。

import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import {
  installCleanupHandlers,
  registerLiveGroup,
} from "./signal-cleanup.mjs";

/** The candidate's own vitest, run through node (no pnpm, no install). */
export const KEEP_TEST_RUNNER = "node_modules/vitest/vitest.mjs";
export const KEEP_TEST_CONFIG = "vitest.config.ts";
/** A guard against a hung runner (not a K6/4 threshold). */
export const KEEP_TEST_TIMEOUT_MS = 300_000;
/** The candidate's lock and the lock pnpm wrote for the install (P2-4 (a)). */
export const KEEP_TEST_LOCKFILE = "pnpm-lock.yaml";
export const KEEP_TEST_INSTALLED_LOCK = "node_modules/.pnpm/lock.yaml";
/**
 * P2-4 (b): the only env names the runner gets (when set). No NODE_OPTIONS,
 * no VITEST_*, no DISPLAY／XAUTHORITY／WAYLAND_*／DBUS_*, no proxy.
 */
export const KEEP_TEST_ENV_ALLOWLIST = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "TMPDIR",
  "TZ",
  "USER",
]);
/** P2-4 (c): the bytes of stdout／stderr kept in the observation. */
export const KEEP_TEST_LOG_TAIL_BYTES = 4_096;
/** How long the pipes may stay open after the group is killed. */
const PIPE_CLOSE_GRACE_MS = 2_000;
const COMMIT = /^[0-9a-f]{40}$/u;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitText(cwd, args) {
  try {
    return git(cwd, args).toString("utf8").trim();
  } catch {
    return null;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function realOrNull(file) {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/** Clean: no change and no untracked file that is not ignored. */
function isClean(worktree) {
  const status = gitText(worktree, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  return status === "";
}

/**
 * The vitest JSON report of one run, read mechanically (pure): exactly one
 * file (the keep test of `worktree`), at least one test, every test passed.
 */
export function assessKeepTestReport(report, { worktree, testFile }) {
  const refused = (reason) => ({
    status: "refused",
    reason,
    tests: null,
    runDigest: null,
  });
  if (report === null || typeof report !== "object" || Array.isArray(report))
    return refused("report-unreadable");
  const results = Array.isArray(report.testResults) ? report.testResults : [];
  const expected = path.join(worktree, testFile);
  if (results.length !== 1 || results[0]?.name !== expected)
    return refused("report-not-this-file");
  const assertions = Array.isArray(results[0].assertionResults)
    ? results[0].assertionResults
    : [];
  if (!Number.isInteger(report.numTotalTests) || report.numTotalTests < 1)
    return refused("no-tests");
  if (
    report.success !== true ||
    results[0].status !== "passed" ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numPassedTests !== report.numTotalTests ||
    assertions.length !== report.numTotalTests ||
    !assertions.every(
      (row) => row?.status === "passed" && typeof row.fullName === "string",
    )
  )
    return refused("failed");
  return {
    status: "passed",
    reason: null,
    tests: { total: report.numTotalTests, passed: report.numPassedTests },
    // Deterministic: the file and each test's name and status, in order
    // (no time, no duration).
    runDigest: sha256(
      JSON.stringify({
        testFile,
        assertions: assertions.map((row) => [row.fullName, row.status]),
      }),
    ),
  };
}

/**
 * P2-4 (a): the version of vitest the candidate's lock gives the root
 * importer (`importers: .: devDependencies|dependencies: vitest: version:`),
 * without its peer suffix; null when the lock does not lock it.
 */
export function lockedVitestVersion(lockText) {
  let section = null;
  let importer = null;
  let inVitest = false;
  for (const line of lockText.split("\n")) {
    if (/^\S/u.test(line)) {
      section = line.replace(/:.*$/u, "");
      importer = null;
      inVitest = false;
      continue;
    }
    if (section !== "importers") continue;
    const importerMatch = /^ {2}(\S.*):$/u.exec(line);
    if (importerMatch) {
      importer = importerMatch[1];
      inVitest = false;
      continue;
    }
    if (importer !== ".") continue;
    if (/^ {4}\S/u.test(line)) {
      inVitest = false;
      continue;
    }
    if (/^ {6}\S/u.test(line)) {
      inVitest = /^ {6}vitest:\s*$/u.test(line);
      continue;
    }
    const version = inVitest ? /^ {8}version:\s*(\S+)/u.exec(line) : null;
    if (version) return version[1].replace(/\(.*$/u, "");
  }
  return null;
}

/**
 * P2-4 (a): the install the runner would use is the candidate's own: the
 * installed lock is byte-equal to the candidate's lock, `node_modules` and
 * `node_modules/vitest` resolve inside the worktree, and vitest's version is
 * the locked one. Returns `{ reason, dependencies }`.
 */
export function inspectKeepTestDependencies({ root, worktree, head }) {
  const dependencies = {
    lockfileSha256: null,
    installedLockSha256: null,
    vitestVersion: null,
    lockedVitestVersion: null,
  };
  let lock;
  try {
    lock = git(root, ["show", `${head}:${KEEP_TEST_LOCKFILE}`]);
  } catch {
    return { reason: "lockfile-missing", dependencies };
  }
  dependencies.lockfileSha256 = sha256(lock);
  dependencies.lockedVitestVersion = lockedVitestVersion(lock.toString("utf8"));
  const modules = path.join(worktree, "node_modules");
  const realModules = realOrNull(modules);
  if (realModules === null)
    return { reason: "node-modules-missing", dependencies };
  if (realModules !== modules)
    return { reason: "node-modules-outside-worktree", dependencies };
  let installed;
  try {
    installed = readFileSync(path.join(worktree, KEEP_TEST_INSTALLED_LOCK));
  } catch {
    return { reason: "node-modules-missing", dependencies };
  }
  dependencies.installedLockSha256 = sha256(installed);
  if (dependencies.installedLockSha256 !== dependencies.lockfileSha256)
    return { reason: "node-modules-lock-differs", dependencies };
  const vitest = realOrNull(path.join(modules, "vitest"));
  if (vitest === null) return { reason: "node-modules-missing", dependencies };
  if (!vitest.startsWith(`${modules}${path.sep}`))
    return { reason: "vitest-outside-worktree", dependencies };
  try {
    const version = JSON.parse(
      readFileSync(path.join(vitest, "package.json"), "utf8"),
    ).version;
    dependencies.vitestVersion = typeof version === "string" ? version : null;
  } catch {
    // unreadable: the version check below refuses
  }
  if (dependencies.lockedVitestVersion === null)
    return { reason: "vitest-not-locked", dependencies };
  if (dependencies.vitestVersion !== dependencies.lockedVitestVersion)
    return { reason: "vitest-version-differs", dependencies };
  return { reason: null, dependencies };
}

/** P2-4 (b): the runner's env, from the allowlist only. */
export function keepTestEnv(source = process.env) {
  const env = {};
  for (const name of KEEP_TEST_ENV_ALLOWLIST)
    if (typeof source[name] === "string") env[name] = source[name];
  return env;
}

/** The live members of process group `pgid` (Linux /proc; zombies excluded). */
export function processGroupMembers(pgid, { procRoot = "/proc" } = {}) {
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    let stat;
    try {
      stat = readFileSync(path.join(procRoot, entry, "stat"), "utf8");
    } catch {
      continue;
    }
    // After the last ")": state ppid pgrp …
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pgid && fields[0] !== "Z")
      members.push(Number(entry));
  }
  return members;
}

function killGroup(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // the group is gone
  }
}

function tailOf(chunks) {
  const all = Buffer.concat(chunks);
  return all
    .subarray(Math.max(0, all.length - KEEP_TEST_LOG_TAIL_BYTES))
    .toString("utf8");
}

/**
 * P2-4 (d): runs `args` with node in its own process group. Resolves after
 * the runner exited (or was killed on `timeoutMs`), the group's leftovers
 * were seen and killed, and the pipes closed (bounded).
 */
function runInGroup(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        error,
        exitCode: null,
        signal: null,
        timedOut: false,
        leftover: [],
        stdout: "",
        stderr: "",
        stdoutLog: Buffer.alloc(0),
        stderrLog: Buffer.alloc(0),
      });
      return;
    }
    const pgid = child.pid;
    const unregister =
      typeof pgid === "number" ? registerLiveGroup(pgid) : () => {};
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(pgid);
    }, timeoutMs);
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const leftover =
        typeof pgid === "number" ? processGroupMembers(pgid) : [];
      if (typeof pgid === "number") killGroup(pgid);
      const done = () => {
        unregister();
        resolve({
          error: spawnError,
          exitCode,
          signal,
          timedOut,
          leftover,
          stdout: tailOf(stdout),
          stderr: tailOf(stderr),
          stdoutLog: Buffer.concat(stdout),
          stderrLog: Buffer.concat(stderr),
        });
      };
      if (child.stdout.closed && child.stderr.closed) {
        done();
        return;
      }
      const grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        done();
      }, PIPE_CLOSE_GRACE_MS);
      child.once("close", () => {
        clearTimeout(grace);
        done();
      });
    };
    child.once("error", (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.once("exit", (code, signal) => finish(code, signal));
  });
}

/**
 * Runs the keep test on `worktree` for the candidate `candidateHead` of the
 * repository `root` and resolves to the observation (unsealed). `timeoutMs`
 * is a hang guard only. `logDir` (optional) receives the runner's stdout and
 * stderr (`keep-test.stdout.log`, `keep-test.stderr.log`).
 */
export async function runKeepTest({
  root,
  worktree,
  candidateHead,
  testFile,
  timeoutMs = KEEP_TEST_TIMEOUT_MS,
  logDir = null,
}) {
  const head = gitText(root, [
    "rev-parse",
    "--verify",
    `${candidateHead}^{commit}`,
  ]);
  if (head === null || !COMMIT.test(head))
    throw new Error(
      `[precheck] the candidate ${candidateHead} is not a commit`,
    );
  const env = keepTestEnv();
  const base = {
    candidateHead: head,
    worktreeHead: null,
    testFile,
    testFileSha256: null,
    dependencies: null,
    env: Object.keys(env).sort(),
  };
  const refused = (reason, extra = {}) => ({
    ...base,
    status: "refused",
    reason,
    tests: null,
    runDigest: null,
    ...extra,
  });
  const real = realOrNull(worktree);
  const top =
    real === null ? null : gitText(real, ["rev-parse", "--show-toplevel"]);
  if (real === null || top === null || realOrNull(top) !== real)
    return refused("worktree-not-a-git-worktree");
  base.worktreeHead = gitText(real, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (base.worktreeHead !== head) return refused("head-differs");
  if (!isClean(real)) return refused("worktree-not-clean");
  let bytes;
  try {
    bytes = git(root, ["show", `${head}:${testFile}`]);
  } catch {
    return refused("test-file-missing");
  }
  base.testFileSha256 = sha256(bytes);
  if (
    gitText(root, ["rev-parse", `${head}:${testFile}`]) !==
    gitText(real, ["rev-parse", `HEAD:${testFile}`])
  )
    return refused("test-file-missing");
  const inspected = inspectKeepTestDependencies({ root, worktree: real, head });
  base.dependencies = inspected.dependencies;
  if (inspected.reason !== null) return refused(inspected.reason);
  // (d) the handler is in place before the runner exists.
  installCleanupHandlers();
  const outDir = mkdtempSync(path.join(tmpdir(), "cp4-keep-test-"));
  const outputFile = path.join(outDir, "report.json");
  try {
    const run = await runInGroup(
      [
        path.join(real, KEEP_TEST_RUNNER),
        "run",
        "--config",
        KEEP_TEST_CONFIG,
        "--reporter=json",
        `--outputFile=${outputFile}`,
        testFile,
      ],
      { cwd: real, env, timeoutMs },
    );
    if (typeof logDir === "string") {
      writeFileSync(path.join(logDir, "keep-test.stdout.log"), run.stdoutLog);
      writeFileSync(path.join(logDir, "keep-test.stderr.log"), run.stderrLog);
    }
    const failed = (reason) =>
      refused(reason, {
        exitCode: run.exitCode,
        signal: run.signal,
        timedOut: run.timedOut,
        leftoverPids: run.leftover,
        stdoutTail: run.stdout,
        stderrTail: run.stderr,
      });
    if (run.error || run.timedOut || run.signal !== null)
      return failed("runner-failed");
    if (run.leftover.length > 0) return failed("runner-left-processes");
    let report;
    try {
      report = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch {
      return failed("runner-failed");
    }
    const assessed = assessKeepTestReport(report, {
      worktree: real,
      testFile,
    });
    if (assessed.status !== "passed") return failed(assessed.reason);
    if (run.exitCode !== 0) return failed("runner-exit-nonzero");
    // The run must not have changed the candidate's tree.
    if (
      gitText(real, ["rev-parse", "--verify", "HEAD^{commit}"]) !== head ||
      !isClean(real)
    )
      return failed("worktree-changed-during-run");
    return {
      ...base,
      status: "passed",
      reason: null,
      tests: assessed.tests,
      runDigest: assessed.runDigest,
      exitCode: 0,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
