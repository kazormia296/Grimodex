// Prereg v2 §0 (D7): the first formal run must start after the v2 final text
// and the implementation were on the remote. Synthetic receipts, a throwaway
// git repository for the v2 file, and a made-up remote time record.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";
import {
  FIRST_RUN_RECEIPT_KINDS,
  checkFirstRunPrecheck,
  firstFormalRunOf,
  loadFirstRunInputs,
  sha256,
} from "./quality-verdict-cli.mjs";
import { H40 } from "./test-support.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const ROOT = mkdtempSync(path.join(tmpdir(), "qv-first-run-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

const S4 = H40("a");
const CANDIDATE = H40("b");
const ALLOW = { s4Commit: S4, candidate: CANDIDATE };
const V2_BYTES = "# v2 final\n";

// A throwaway repository: the v2 file at one commit.
const REPO = path.join(ROOT, "contracts");
mkdirSync(path.join(REPO, "docs"), { recursive: true });
git(REPO, "init", "-q", "-b", "main");
writeFileSync(path.join(REPO, "docs/v2.md"), V2_BYTES);
git(REPO, "add", "docs/v2.md");
git(
  REPO,
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.invalid",
  "commit",
  "-q",
  "-m",
  "v2",
);
const V2_COMMIT = git(REPO, "rev-parse", "HEAD");
const IMPL_COMMIT = H40("d");
const V2_SHA = sha256(V2_BYTES);

const receipt = (kind, at, pair = ALLOW) => ({
  runId: `${kind}/${at}`,
  runKind: kind,
  head: {
    observationPrep: { commit: pair.s4Commit },
    runStartedAtUtc: at,
  },
  candidate: { commit: pair.candidate },
});
const byKind = (starts, pair = ALLOW) =>
  Object.fromEntries(
    FIRST_RUN_RECEIPT_KINDS.map((kind) => [
      kind,
      [
        {
          path: `${kind}.receipt.json`,
          receipt: receipt(kind, starts[kind], pair),
        },
      ],
    ]),
  );
const STARTS = {
  "sp-p4": "2026-11-09T03:00:00.000Z",
  trace: "2026-11-09T04:00:00.000Z",
  parity: "2026-11-09T05:00:00.000Z",
  gold: "2026-11-09T06:00:00.000Z",
  negative: "2026-11-09T07:00:00.000Z",
  "g01-diagnostic": "2026-11-09T08:00:00.000Z",
};
const remote = (commit, remoteTimeUtc, source = "PushEvent") => ({
  commit,
  branch: "claude/x",
  remoteTimeUtc,
  source,
});
const RECORDS = [
  remote(V2_COMMIT, "2026-11-09T01:00:00Z", "repository-activity"),
  remote(IMPL_COMMIT, "2026-11-09T02:00:00Z"),
];

test("v2 §0: the first formal run is the earliest head.runStartedAtUtc over all six kinds of the judged pair", () => {
  const first = firstFormalRunOf(byKind(STARTS), ALLOW);
  assert.equal(first.atUtc, STARTS["sp-p4"]);
  assert.equal(first.kind, "sp-p4");
  assert.deepEqual(first.receiptCounts, {
    "sp-p4": 1,
    trace: 1,
    parity: 1,
    gold: 1,
    negative: 1,
    "g01-diagnostic": 1,
  });
  // Any kind may hold the earliest (the verdict used to read Gold and parity only).
  for (const kind of FIRST_RUN_RECEIPT_KINDS) {
    const early = firstFormalRunOf(
      byKind({ ...STARTS, [kind]: "2026-11-09T00:30:00.000Z" }),
      ALLOW,
    );
    assert.equal(early.kind, kind);
    assert.equal(early.atUtc, "2026-11-09T00:30:00.000Z");
  }
  // A kind with no receipt of the pair, or a receipt of another pair, is [precheck].
  for (const kind of FIRST_RUN_RECEIPT_KINDS) {
    const rows = byKind(STARTS);
    rows[kind] = [];
    assert.throws(
      () => firstFormalRunOf(rows, ALLOW),
      /\[precheck\].*no /u,
      kind,
    );
    assert.throws(
      () =>
        firstFormalRunOf(
          {
            ...byKind(STARTS),
            [kind]: byKind(STARTS, { s4Commit: S4, candidate: H40("e") })[kind],
          },
          ALLOW,
        ),
      /\[precheck\]/u,
      kind,
    );
  }
  // A receipt without a readable start time is [precheck].
  const bad = byKind(STARTS);
  bad.trace[0].receipt.head.runStartedAtUtc = "yesterday";
  assert.throws(
    () => firstFormalRunOf(bad, ALLOW),
    /readable head\.runStartedAtUtc/u,
  );
});

test("v2 §0: both commits must be on the remote strictly before the first formal run; a missing record or time is [precheck]", () => {
  const firstRun = firstFormalRunOf(byKind(STARTS), ALLOW);
  const check = (records, extra = {}) =>
    checkFirstRunPrecheck({
      v2Commit: V2_COMMIT,
      v2Sha256: V2_SHA,
      implCommit: IMPL_COMMIT,
      remoteRecords: records,
      firstRun,
      ...extra,
    });
  const out = check(RECORDS);
  assert.equal(out.v2.commit, V2_COMMIT);
  assert.equal(out.v2.sha256, V2_SHA);
  assert.equal(out.v2.remoteTimeUtc, "2026-11-09T01:00:00Z");
  assert.equal(out.v2.source, "repository-activity");
  assert.equal(out.implementation.commit, IMPL_COMMIT);
  assert.equal(out.implementation.source, "PushEvent");
  assert.equal(out.firstFormalRun.atUtc, STARTS["sp-p4"]);
  assert.equal(out.firstFormalRun.receipt, "sp-p4.receipt.json");
  // Each commit, on its own, is late: at the same instant is not before.
  for (const [commit, time] of [
    [V2_COMMIT, STARTS["sp-p4"]],
    [IMPL_COMMIT, "2026-11-09T03:00:00.001Z"],
  ])
    assert.throws(
      () =>
        check(
          RECORDS.map((row) =>
            row.commit === commit ? { ...row, remoteTimeUtc: time } : row,
          ),
        ),
      /not before the first formal run/u,
    );
  // A record without one of the commits, an unreadable time, an unknown source.
  assert.throws(
    () => check(RECORDS.slice(0, 1)),
    /no entry for the implementation/u,
  );
  assert.throws(() => check(RECORDS.slice(1)), /no entry for the v2/u);
  assert.throws(
    () => check([{ ...RECORDS[0], remoteTimeUtc: "later" }, RECORDS[1]]),
    /readable remoteTimeUtc/u,
  );
  assert.throws(
    () => check([{ ...RECORDS[0], source: "local-clock" }, RECORDS[1]]),
    /source local-clock/u,
  );
  assert.throws(() => check({}), /not a list/u);
  assert.throws(() => check(RECORDS, { implCommit: "abc" }), /full commit ID/u);
  // The earliest record of a commit counts (a re-push later does not move it).
  assert.equal(
    check([...RECORDS, remote(V2_COMMIT, "2026-11-09T09:00:00Z")]).v2
      .remoteTimeUtc,
    "2026-11-09T01:00:00Z",
  );
});

test("v2 §0: loadFirstRunInputs reads the six directories, the record and the v2 bytes at the v2 commit; a missing input or a differing v2 file is [precheck]", () => {
  const dirs = {};
  for (const kind of FIRST_RUN_RECEIPT_KINDS) {
    const dir = path.join(ROOT, `receipts-${kind}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${kind}.receipt.json`),
      JSON.stringify(receipt(kind, STARTS[kind])),
    );
    dirs[kind] = dir;
  }
  const recordPath = path.join(ROOT, "remote-record.json");
  writeFileSync(recordPath, JSON.stringify(RECORDS));
  const base = {
    v2File: path.join(REPO, "docs/v2.md"),
    v2Commit: V2_COMMIT,
    implCommit: IMPL_COMMIT,
    remoteTimeRecordPath: recordPath,
    dirs,
    allowList: ALLOW,
  };
  const loaded = loadFirstRunInputs(base);
  assert.equal(loaded.result.v2.sha256, V2_SHA);
  assert.equal(loaded.result.firstFormalRun.kind, "sp-p4");
  assert.equal(loaded.bindings.v2File.sha256, V2_SHA);
  assert.equal(loaded.bindings.remoteTimeRecord.path, recordPath);
  // Every input is required.
  for (const key of [
    "v2File",
    "v2Commit",
    "implCommit",
    "remoteTimeRecordPath",
  ])
    assert.throws(
      () => loadFirstRunInputs({ ...base, [key]: undefined }),
      /\[precheck\].*missing/u,
      key,
    );
  for (const kind of FIRST_RUN_RECEIPT_KINDS)
    assert.throws(
      () =>
        loadFirstRunInputs({ ...base, dirs: { ...dirs, [kind]: undefined } }),
      /receipt directory is missing/u,
      kind,
    );
  // The v2 file's bytes differ from the commit's.
  const changed = path.join(REPO, "docs/v2-copy.md");
  writeFileSync(changed, "# edited\n");
  assert.throws(
    () => loadFirstRunInputs({ ...base, v2File: changed }),
    /\[precheck\]/u,
  );
  writeFileSync(
    path.join(REPO, "docs/v2.md"),
    "# v2 edited after the commit\n",
  );
  assert.throws(
    () => loadFirstRunInputs(base),
    /differs from the bytes of that path at the v2 commit/u,
  );
  writeFileSync(path.join(REPO, "docs/v2.md"), V2_BYTES);
  // A late commit stops the run through the same path.
  writeFileSync(
    recordPath,
    JSON.stringify([remote(V2_COMMIT, "2026-11-10T00:00:00Z"), RECORDS[1]]),
  );
  assert.throws(
    () => loadFirstRunInputs(base),
    /not before the first formal run/u,
  );
});

test("v2 §0: the command line refuses a verdict without the first-run inputs", () => {
  const cli = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "quality-verdict-cli.mjs",
  );
  let failure = null;
  try {
    execFileSync(
      process.execPath,
      [
        // The mutation hook (--import) of a detection run reaches this child too.
        ...process.execArgv,
        cli,
        "--gold-dir",
        ROOT,
        "--allow-list",
        path.join(ROOT, "allow.json"),
        "--out",
        path.join(ROOT, "out.json"),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "the command must fail");
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /\[precheck\] v2 §0: --v2-file is required/u);
});
