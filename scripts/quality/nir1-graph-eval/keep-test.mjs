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
// この module は結果を封印しない。封印は admission.mjs の
// `collectRatification5Evidence` だけが行う（sealer は admission.mjs が load の時に
// 一度だけ取る。admission-facts.mjs）。試験専用の封印（test-support の
// `claimTestEvidenceSealer`）は本番の入口から呼べないまま。

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

/** The candidate's own vitest, run through node (no pnpm, no install). */
export const KEEP_TEST_RUNNER = "node_modules/vitest/vitest.mjs";
export const KEEP_TEST_CONFIG = "vitest.config.ts";
/** A guard against a hung runner (not a K6/4 threshold). */
export const KEEP_TEST_TIMEOUT_MS = 300_000;
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
 * Runs the keep test on `worktree` for the candidate `candidateHead` of the
 * repository `root` and returns the observation (unsealed). `timeoutMs` is a
 * hang guard only.
 */
export function runKeepTest({
  root,
  worktree,
  candidateHead,
  testFile,
  timeoutMs = KEEP_TEST_TIMEOUT_MS,
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
  const base = {
    candidateHead: head,
    worktreeHead: null,
    testFile,
    testFileSha256: null,
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
  const outDir = mkdtempSync(path.join(tmpdir(), "cp4-keep-test-"));
  const outputFile = path.join(outDir, "report.json");
  try {
    const run = spawnSync(
      process.execPath,
      [
        path.join(real, KEEP_TEST_RUNNER),
        "run",
        "--config",
        KEEP_TEST_CONFIG,
        "--reporter=json",
        `--outputFile=${outputFile}`,
        testFile,
      ],
      {
        cwd: real,
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );
    if (run.error || run.signal !== null)
      return refused("runner-failed", { exitCode: run.status ?? null });
    let report;
    try {
      report = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch {
      return refused("runner-failed", { exitCode: run.status });
    }
    const assessed = assessKeepTestReport(report, {
      worktree: real,
      testFile,
    });
    if (assessed.status !== "passed")
      return refused(assessed.reason, { exitCode: run.status });
    if (run.status !== 0)
      return refused("runner-exit-nonzero", { exitCode: run.status });
    // The run must not have changed the candidate's tree.
    if (
      gitText(real, ["rev-parse", "--verify", "HEAD^{commit}"]) !== head ||
      !isClean(real)
    )
      return refused("worktree-changed-during-run", { exitCode: run.status });
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
