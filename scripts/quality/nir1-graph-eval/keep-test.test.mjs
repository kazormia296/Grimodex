// 批准 5 の (b) の keep test の collector（S1f、DR-CP4-H-21 の続き）。一時の git
// repository と、ignore された `node_modules/vitest/vitest.mjs` に置いた偽の runner
// （mode.json に従って JSON の報告を書く）で試す。本物の vitest は走らせない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { K64_CANDIDATE_REQUIREMENTS } from "./constants.mjs";
import { assessKeepTestReport, runKeepTest } from "./keep-test.mjs";
import {
  keepTestCandidate as candidateRepository,
  testGit as git,
} from "./test-support.mjs";

const TEST_FILE = K64_CANDIDATE_REQUIREMENTS.rsJoinKeepTest;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("keep test: 候補の clean な worktree で走らせ、全件 pass なら head・試験 file の sha256・件数・digest を返す", async () => {
  const { repo, head, mode } = await candidateRepository();
  try {
    const result = runKeepTest({
      root: repo,
      worktree: repo,
      candidateHead: head,
      testFile: TEST_FILE,
    });
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.reason, null);
    assert.equal(result.worktreeHead, head);
    assert.equal(
      result.testFileSha256,
      sha256(await readFile(path.join(repo, TEST_FILE))),
    );
    assert.deepEqual(result.tests, { total: 2, passed: 2 });
    assert.match(result.runDigest, /^[0-9a-f]{64}$/u);
    // 同じ結果なら digest は同じ（時刻を含まない）。
    assert.equal(
      runKeepTest({
        root: repo,
        worktree: repo,
        candidateHead: head,
        testFile: TEST_FILE,
      }).runDigest,
      result.runDigest,
    );
    // 落ちた試験、0 件、skip、別の file の報告は refused。
    for (const [value, reason] of [
      [
        {
          kind: "report",
          assertions: [
            ["a", "passed"],
            ["b", "failed"],
          ],
        },
        "failed",
      ],
      [{ kind: "report", assertions: [] }, "no-tests"],
      [
        {
          kind: "report",
          assertions: [
            ["a", "passed"],
            ["b", "skipped"],
          ],
        },
        "failed",
      ],
      [
        {
          kind: "report",
          assertions: [["a", "passed"]],
          name: "/elsewhere.test.tsx",
        },
        "report-not-this-file",
      ],
      [
        { kind: "report", assertions: [["a", "passed"]], exit: 1 },
        "runner-exit-nonzero",
      ],
      [{ kind: "crash" }, "runner-failed"],
      [
        { kind: "report", assertions: [["a", "passed"]], touch: "stray.txt" },
        "worktree-changed-during-run",
      ],
    ]) {
      await mode(value);
      await rm(path.join(repo, "stray.txt"), { force: true });
      const refused = runKeepTest({
        root: repo,
        worktree: repo,
        candidateHead: head,
        testFile: TEST_FILE,
      });
      assert.equal(refused.status, "refused", JSON.stringify(value));
      assert.equal(refused.reason, reason, JSON.stringify(value));
      assert.equal(refused.runDigest, null);
    }
    await rm(path.join(repo, "stray.txt"), { force: true });
    await mode({ kind: "hang" });
    const hung = runKeepTest({
      root: repo,
      worktree: repo,
      candidateHead: head,
      testFile: TEST_FILE,
      timeoutMs: 500,
    });
    assert.equal(hung.reason, "runner-failed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("keep test: worktree が clean でない、head が候補と違う、試験 file が無い、git の worktree でないなら走らせない", async () => {
  const { repo, head, mode } = await candidateRepository();
  try {
    await mode({ kind: "report", assertions: [["a", "passed"]] });
    const run = (overrides = {}) =>
      runKeepTest({
        root: repo,
        worktree: repo,
        candidateHead: head,
        testFile: TEST_FILE,
        ...overrides,
      });
    await writeFile(path.join(repo, "untracked.txt"), "x");
    assert.equal(run().reason, "worktree-not-clean");
    await rm(path.join(repo, "untracked.txt"));
    await writeFile(path.join(repo, TEST_FILE), "// edited\n");
    assert.equal(run().reason, "worktree-not-clean");
    git(repo, "checkout", "--", TEST_FILE);
    git(repo, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "next");
    assert.equal(run().reason, "head-differs");
    const next = git(repo, "rev-parse", "HEAD");
    assert.equal(run({ candidateHead: next }).status, "passed");
    assert.equal(
      run({ candidateHead: next, testFile: "src/missing.test.tsx" }).reason,
      "test-file-missing",
    );
    const plain = await mkdtemp(path.join(tmpdir(), "cp4-keep-plain-"));
    try {
      assert.equal(
        run({ candidateHead: next, worktree: plain }).reason,
        "worktree-not-a-git-worktree",
      );
      // repository の下の directory は worktree の top level ではない。
      assert.equal(
        run({ candidateHead: next, worktree: path.join(repo, "src") }).reason,
        "worktree-not-a-git-worktree",
      );
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("keep test: 報告の検査は 1 file・全件 pass・0 件でないことを求める（純粋）", () => {
  const worktree = "/w";
  const report = (assertions, extra = {}) => ({
    numTotalTests: assertions.length,
    numPassedTests: assertions.filter((row) => row.status === "passed").length,
    numFailedTests: assertions.filter((row) => row.status === "failed").length,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: [
      {
        name: path.join(worktree, TEST_FILE),
        status: "passed",
        assertionResults: assertions,
      },
    ],
    ...extra,
  });
  const ok = [{ fullName: "k a", status: "passed" }];
  assert.equal(
    assessKeepTestReport(report(ok), { worktree, testFile: TEST_FILE }).status,
    "passed",
  );
  for (const [value, reason] of [
    [null, "report-unreadable"],
    [report(ok, { success: false }), "failed"],
    [report(ok, { numPendingTests: 1 }), "failed"],
    [report(ok, { testResults: [] }), "report-not-this-file"],
    [
      report(ok, {
        testResults: [
          ...report(ok).testResults,
          { ...report(ok).testResults[0], name: "/w/other.test.tsx" },
        ],
      }),
      "report-not-this-file",
    ],
    [report([]), "no-tests"],
    [report(ok, { numTotalTests: 2, numPassedTests: 2 }), "failed"],
  ])
    assert.equal(
      assessKeepTestReport(value, { worktree, testFile: TEST_FILE }).reason,
      reason,
      JSON.stringify(value)?.slice(0, 120),
    );
});
