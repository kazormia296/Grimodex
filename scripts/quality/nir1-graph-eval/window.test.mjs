// CP-4 S1c-2 D3 window samples (pure parsers). Synthetic /proc text only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessMeasurementWindow } from "./receipt.mjs";
import {
  ancestorPids,
  classifyProcess,
  heavySlotsInUse,
  lockedInodes,
  windowFields,
} from "./window.mjs";

const LOCKS = [
  "1: FLOCK  ADVISORY  WRITE 15660 08:02:156114 0 EOF",
  "2: POSIX  ADVISORY  WRITE 15516 08:02:25985902 0 EOF",
  "2: -> FLOCK  ADVISORY  WRITE 17000 08:02:194868 0 EOF",
].join("\n");

test("heavy.sh slots in use are read from /proc/locks holders, never waiters", () => {
  assert.deepEqual([...lockedInodes(LOCKS)].sort(), [156114, 25985902]);
  assert.equal(
    heavySlotsInUse({ locksText: LOCKS, slotInodes: [156114, 194868] }),
    1,
  );
  assert.equal(heavySlotsInUse({ locksText: "", slotInodes: [156114] }), 0);
});

test("build, test and measurement processes are classified from argv", () => {
  assert.deepEqual(classifyProcess(["/usr/bin/cargo", "build"]), {
    kind: "build",
    command: "cargo",
  });
  assert.deepEqual(classifyProcess(["rustc", "--crate-name", "x"]), {
    kind: "build",
    command: "rustc",
  });
  assert.equal(
    classifyProcess(["node", "/x/napi.js", "build", "--release"]).command,
    "napi build",
  );
  assert.equal(
    classifyProcess(["node", "/x/vite.js", "build"]).command,
    "vite build",
  );
  assert.equal(
    classifyProcess(["node", "/x/vitest.mjs", "--run"]).kind,
    "test",
  );
  assert.equal(
    classifyProcess(["node", "scripts/run-nir1-retrieval.mjs"]).kind,
    "measurement",
  );
  assert.equal(
    classifyProcess([
      "node",
      "scripts/quality/nir1-graph-eval/runner.mjs",
      "--run",
      "x",
    ]).kind,
    "measurement",
  );
  assert.equal(classifyProcess(["node", "server.js"]), null);
  assert.equal(classifyProcess([]), null);
});

test("the harness's own processes are excluded and a build in this worktree is flagged", () => {
  const root = "/w/tree";
  const fields = windowFields({
    processes: [
      {
        pid: 1,
        argv: ["node", "scripts/quality/nir1-graph-eval/runner.mjs"],
        cwd: root,
      },
      { pid: 2, argv: ["cargo", "build"], cwd: "/other" },
      { pid: 3, argv: ["rustc", "x"], cwd: `${root}/src-tauri` },
      { pid: 4, argv: ["node", "/x/vitest.mjs"], cwd: "/other" },
    ],
    ownPids: [1],
    root,
    heavySlots: 2,
    locksReadable: true,
    heavySlotFiles: 3,
  });
  assert.deepEqual(fields.buildProcesses, [
    { pid: 2, command: "cargo" },
    { pid: 3, command: "rustc" },
  ]);
  assert.deepEqual(fields.otherMeasurements, ["test:vitest/playwright:4"]);
  assert.equal(fields.sameWorktreeBuild, true);
  assert.equal(fields.heavySlotsInUse, 2);
  // The S1b window assessment reads exactly these fields.
  const run = { startedAtMs: 10, finishedAtMs: 20 };
  const assessment = assessMeasurementWindow({
    samples: [
      { atMs: 0, ...fields },
      { atMs: 30, ...fields },
    ],
    run,
    ownPids: [],
  });
  assert.equal(assessment.clean, false);
  assert.deepEqual(assessment.gaps, []);
  assert.ok(assessment.violations.some((row) => /heavy slot/u.test(row)));
  const quiet = windowFields({
    processes: [{ pid: 1, argv: ["cargo", "build"], cwd: root }],
    ownPids: [1],
    root,
    heavySlots: 0,
    locksReadable: true,
    heavySlotFiles: 3,
  });
  assert.equal(quiet.sameWorktreeBuild, false);
  assert.deepEqual(quiet.buildProcesses, []);
});

test("P3-10: /proc/locks が読めない標本は 0 でなく null で、見た slot の file の数を残す", () => {
  const unread = windowFields({
    processes: [],
    ownPids: [],
    root: "/w/tree",
    heavySlots: 0,
    locksReadable: false,
    heavySlotFiles: 3,
  });
  assert.equal(unread.heavySlotsInUse, null);
  assert.equal(unread.locksReadable, false);
  assert.equal(unread.heavySlotFiles, 3);
  const assessment = assessMeasurementWindow({
    samples: [
      { atMs: 0, ...unread },
      { atMs: 30, ...unread },
    ],
    run: { startedAtMs: 10, finishedAtMs: 20 },
  });
  assert.equal(assessment.clean, false);
  assert.match(assessment.gaps.join(), /\/proc\/locks/);
});

test("P3-10: hook-check、dprime-check、diag-registration、smoke の並走も別の計測として数える", () => {
  for (const script of [
    "hook-check",
    "dprime-check",
    "diag-registration",
    "smoke",
    "runner",
    "setup-driver",
  ])
    assert.deepEqual(
      classifyProcess([
        "node",
        `scripts/quality/nir1-graph-eval/${script}.mjs`,
      ]),
      { kind: "measurement", command: "cp4" },
      script,
    );
});

test("the launcher chain (the wrapper that carries the runner's argv) is the harness's own", () => {
  const stats = {
    40: "40 (node) S 30 40 40 0",
    30: "30 (node xvfb (wrap)) S 20 30 30 0",
    20: "20 (bash) S 1 20 20 0",
  };
  assert.deepEqual(
    ancestorPids(40, (pid) => stats[pid]),
    [40, 30, 20],
  );
  assert.deepEqual(
    ancestorPids(40, () => null),
    [40],
  );
});
