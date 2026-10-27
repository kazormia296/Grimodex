// 批准 5 の (b) の keep test の collector（S1f、DR-CP4-H-21 の続き）。一時の git
// repository と、ignore された `node_modules/vitest/vitest.mjs` に置いた偽の runner
// （mode.json に従って JSON の報告を書く）で試す。本物の vitest は走らせない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { K64_CANDIDATE_REQUIREMENTS } from "./constants.mjs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers";
import { URL, fileURLToPath } from "node:url";
import {
  assessKeepTestReport,
  inspectKeepTestDependencies,
  lockedVitestVersion,
  runKeepTest,
} from "./keep-test.mjs";
import { cleanupHandlersInstalled, liveGroups } from "./signal-cleanup.mjs";
import {
  KEEP_TEST_LOCK,
  keepTestCandidate as candidateRepository,
  testGit as git,
} from "./test-support.mjs";

const TEST_FILE = K64_CANDIDATE_REQUIREMENTS.rsJoinKeepTest;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("keep test: 候補の clean な worktree で走らせ、全件 pass なら head・試験 file の sha256・件数・digest を返す", async () => {
  const { repo, head, mode } = await candidateRepository();
  try {
    const result = await runKeepTest({
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
      (
        await runKeepTest({
          root: repo,
          worktree: repo,
          candidateHead: head,
          testFile: TEST_FILE,
        })
      ).runDigest,
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
      const refused = await runKeepTest({
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
    const hung = await runKeepTest({
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
    assert.equal((await run()).reason, "worktree-not-clean");
    await rm(path.join(repo, "untracked.txt"));
    await writeFile(path.join(repo, TEST_FILE), "// edited\n");
    assert.equal((await run()).reason, "worktree-not-clean");
    git(repo, "checkout", "--", TEST_FILE);
    git(repo, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "next");
    assert.equal((await run()).reason, "head-differs");
    const next = git(repo, "rev-parse", "HEAD");
    assert.equal((await run({ candidateHead: next })).status, "passed");
    assert.equal(
      (await run({ candidateHead: next, testFile: "src/missing.test.tsx" }))
        .reason,
      "test-file-missing",
    );
    const plain = await mkdtemp(path.join(tmpdir(), "cp4-keep-plain-"));
    try {
      assert.equal(
        (await run({ candidateHead: next, worktree: plain })).reason,
        "worktree-not-a-git-worktree",
      );
      // repository の下の directory は worktree の top level ではない。
      assert.equal(
        (await run({ candidateHead: next, worktree: path.join(repo, "src") }))
          .reason,
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

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check, limitMs = 5_000) {
  const started = Date.now();
  while (!check() && Date.now() - started < limitMs)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
}

test("P2-4 (a): install 済みの lock が候補の lock と違う、vitest の版が違う、vitest が worktree の外なら走らせない（依存は入れない）", async () => {
  const { repo, head } = await candidateRepository();
  try {
    const run = () =>
      runKeepTest({
        root: repo,
        worktree: repo,
        candidateHead: head,
        testFile: TEST_FILE,
      });
    const passed = await run();
    assert.equal(passed.status, "passed");
    assert.deepEqual(passed.dependencies, {
      lockfileSha256: sha256(Buffer.from(KEEP_TEST_LOCK)),
      installedLockSha256: sha256(Buffer.from(KEEP_TEST_LOCK)),
      vitestVersion: "4.1.12",
      lockedVitestVersion: "4.1.12",
    });
    const installed = path.join(repo, "node_modules/.pnpm/lock.yaml");
    await writeFile(installed, KEEP_TEST_LOCK.replace("4.1.12(", "4.1.11("));
    assert.equal((await run()).reason, "node-modules-lock-differs");
    await rm(installed);
    assert.equal((await run()).reason, "node-modules-missing");
    await writeFile(installed, KEEP_TEST_LOCK);
    const pkg = path.join(repo, "node_modules/vitest/package.json");
    await writeFile(pkg, JSON.stringify({ name: "vitest", version: "4.1.11" }));
    assert.equal((await run()).reason, "vitest-version-differs");
    await writeFile(pkg, JSON.stringify({ name: "vitest", version: "4.1.12" }));
    // 別の場所の install への symlink（別の候補の node_modules）。
    const outside = await mkdtemp(path.join(tmpdir(), "cp4-keep-outside-"));
    try {
      await rename(
        path.join(repo, "node_modules/vitest"),
        path.join(outside, "vitest"),
      );
      await symlink(
        path.join(outside, "vitest"),
        path.join(repo, "node_modules/vitest"),
      );
      assert.equal((await run()).reason, "vitest-outside-worktree");
      await rm(path.join(repo, "node_modules/vitest"));
      await rename(
        path.join(outside, "vitest"),
        path.join(repo, "node_modules/vitest"),
      );
      // node_modules 自体が別の場所への symlink。
      await rename(
        path.join(repo, "node_modules"),
        path.join(outside, "node_modules"),
      );
      await symlink(
        path.join(outside, "node_modules"),
        path.join(repo, "node_modules"),
      );
      // git は symlink の node_modules を ignore しない（`node_modules/` は
      // directory だけ）ので worktree が clean でない。依存の検査も単独で拒む。
      assert.equal((await run()).reason, "worktree-not-clean");
      assert.equal(
        inspectKeepTestDependencies({ root: repo, worktree: repo, head })
          .reason,
        "node-modules-outside-worktree",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("P2-4 (b)(c): runner の env は最小（NODE_OPTIONS や VITEST_*、DISPLAY を渡さない）で、失敗の stderr の末尾を残す", async () => {
  const { repo, head, mode } = await candidateRepository();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      NODE_OPTIONS: "--no-deprecation",
      VITEST_POOL_ID: "9",
      DISPLAY: ":0",
      XAUTHORITY: "/x",
      WAYLAND_DISPLAY: "wayland-0",
    });
    const result = await runKeepTest({
      root: repo,
      worktree: repo,
      candidateHead: head,
      testFile: TEST_FILE,
    });
    assert.equal(result.status, "passed");
    const seen = JSON.parse(
      await readFile(path.join(repo, "node_modules/vitest/env.json"), "utf8"),
    );
    for (const name of [
      "NODE_OPTIONS",
      "VITEST_POOL_ID",
      "DISPLAY",
      "XAUTHORITY",
      "WAYLAND_DISPLAY",
    ])
      assert.ok(!seen.includes(name), name);
    assert.ok(seen.every((name) => result.env.includes(name)));
    await mode({ kind: "crash" });
    const logDir = await mkdtemp(path.join(tmpdir(), "cp4-keep-log-"));
    try {
      const crashed = await runKeepTest({
        root: repo,
        worktree: repo,
        candidateHead: head,
        testFile: TEST_FILE,
        logDir,
      });
      assert.equal(crashed.reason, "runner-failed");
      assert.match(crashed.stderrTail, /boom-stderr/u);
      assert.match(
        await readFile(path.join(logDir, "keep-test.stderr.log"), "utf8"),
        /boom-stderr/u,
      );
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(repo, { recursive: true, force: true });
  }
});

test("P2-4 (d): timeout でも終了の後でも runner の process group を止め、孫 process を残さない。signal の handler は keep test の前に置かれる", async () => {
  const { repo, head, mode } = await candidateRepository();
  const childPid = async () =>
    Number(
      await readFile(path.join(repo, "node_modules/vitest/child.pid"), "utf8"),
    );
  try {
    await mode({ kind: "hang", child: true });
    const running = runKeepTest({
      root: repo,
      worktree: repo,
      candidateHead: head,
      testFile: TEST_FILE,
      timeoutMs: 1_500,
    });
    assert.ok(await waitFor(() => liveGroups().length > 0));
    assert.equal(cleanupHandlersInstalled(), true);
    const hung = await running;
    assert.equal(hung.reason, "runner-failed");
    const first = await childPid();
    assert.equal(
      await waitFor(() => !alive(first)),
      true,
      "grandchild killed on timeout",
    );
    assert.deepEqual(liveGroups(), []);
    await mode({ kind: "report", child: true, assertions: [["a", "passed"]] });
    const left = await runKeepTest({
      root: repo,
      worktree: repo,
      candidateHead: head,
      testFile: TEST_FILE,
    });
    assert.equal(left.reason, "runner-left-processes");
    const second = await childPid();
    assert.equal(
      await waitFor(() => !alive(second)),
      true,
      "grandchild killed after exit",
    );
    assert.deepEqual(liveGroups(), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("P2-4 (a): 候補の lock の root importer の vitest の版を読む（peer の接尾辞を除く。実際の pnpm-lock.yaml）", () => {
  assert.equal(lockedVitestVersion(KEEP_TEST_LOCK), "4.1.12");
  assert.equal(lockedVitestVersion("lockfileVersion: '9.0'\n"), null);
  // 別の importer の vitest は root のものではない。
  assert.equal(
    lockedVitestVersion(KEEP_TEST_LOCK.replace("  .:\n", "  packages/x:\n")),
    null,
  );
  const repoLock = readFileSync(
    fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url)),
    "utf8",
  );
  assert.match(lockedVitestVersion(repoLock) ?? "", /^\d+\.\d+\.\d+$/u);
});

test("P2-4 (d): keep test の最中に harness が SIGTERM を受けると、handler が runner の group（孫を含む）を止めて 143 で終わる", async () => {
  const { repo, head, mode } = await candidateRepository();
  try {
    await mode({ kind: "hang", child: true });
    const module = fileURLToPath(new URL("./keep-test.mjs", import.meta.url));
    const harness = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runKeepTest } from ${JSON.stringify(module)};
await runKeepTest(${JSON.stringify({ root: repo, worktree: repo, candidateHead: head, testFile: TEST_FILE, timeoutMs: 60_000 })});`,
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise((resolve) =>
      harness.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const pidFile = path.join(repo, "node_modules/vitest/child.pid");
    assert.ok(
      await waitFor(() => {
        try {
          return readFileSync(pidFile, "utf8").length > 0;
        } catch {
          return false;
        }
      }),
    );
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.equal(alive(grandchild), true);
    harness.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 143, signal: null });
    assert.equal(
      await waitFor(() => !alive(grandchild)),
      true,
      "grandchild killed by the handler",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
