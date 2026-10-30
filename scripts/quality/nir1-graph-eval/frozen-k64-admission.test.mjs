// CP-4 S5-A: 正式の run の admission（DR-CP4-N-1 (1)）。使い捨ての git
// repository と、注入した K6/4 の凍結の descriptor（T14 の型）で順序と各検査を
// 確かめる。`admitGraphCaseRun` は依存として差し替える（実物は K6/2 の凍結の
// commit を要し、使い捨ての repository では通らない）。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readAdmittedFixture } from "./admission.mjs";
import {
  FROZEN_FIXTURE_SHA256,
  G01_FIXTURE,
  GRAPH_CASE_FREEZE,
  K62_FREEZE,
  K64_FREEZE,
  OBSERVATION_PREP_RECORD_PATH,
  OBSERVATION_PREP_RECORD_SCHEMA,
} from "./constants.mjs";
import {
  ATTEMPTS_DIR,
  S2_FILES,
  admitFormalK64Run,
  attemptStatusOf,
  assertSourcePins,
  finishAttempt,
  listAttempts,
  selectParity,
  startAttempt,
} from "./frozen-k64-admission.mjs";
import {
  DEV_DRAFT_PROCEDURE_VERSION,
  procedureFilePath,
} from "./procedure-file.mjs";
import { REPO_ROOT, testGit } from "./test-support.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const HARNESS = "scripts/quality/nir1-graph-eval/pinned-harness.mjs";

function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
}

function commit(repo, message, files) {
  testGit(repo, "add", "--", ...files);
  testGit(repo, "commit", "-q", "--no-gpg-sign", "-m", message);
  return testGit(repo, "rev-parse", "HEAD");
}

function procedureText({ draft = false } = {}) {
  const base = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, procedureFilePath(DEV_DRAFT_PROCEDURE_VERSION)),
      "utf8",
    ),
  );
  return `${JSON.stringify(
    {
      ...base,
      version: "v1",
      draft,
      values: { ...base.values, r1r4WaitMs: 3_000 },
      review: draft
        ? null
        : {
            reviewer: "synthetic-reviewer",
            reviewedAt: "2026-10-28",
            record: "synthetic",
          },
    },
    null,
    2,
  )}\n`;
}

/**
 * base: the K6/4 bytes (the freeze commit), the pinned harness file and the
 * frozen material; prep (S4): the S2 files, the procedure v1 and the
 * contract's freeze record binding the S2 files (DR-CP4-S4-1; on
 * origin/master); HEAD = the candidate.
 */
function repository({
  pinSha = null,
  draft = false,
  ancestor = null,
  unbind = null,
} = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "cp4-s5a-admission-"));
  testGit(repo, "init", "-q", "-b", "main");
  write(repo, K64_FREEZE.path, "K6/4 frozen text\n");
  write(repo, HARNESS, "export const pinned = 1;\n");
  for (const file of [GRAPH_CASE_FREEZE.path, G01_FIXTURE.path])
    write(repo, file, readFileSync(path.join(REPO_ROOT, file)));
  const freezeCommit = commit(repo, "freeze", [
    K64_FREEZE.path,
    HARNESS,
    GRAPH_CASE_FREEZE.path,
    G01_FIXTURE.path,
  ]);
  const pins = [
    {
      role: "harness",
      commit: freezeCommit,
      check: "bytes",
      files: [
        {
          path: HARNESS,
          sha256: pinSha ?? sha256("export const pinned = 1;\n"),
        },
      ],
    },
    {
      role: "fix",
      commit: ancestor ?? freezeCommit,
      check: "ancestor",
      files: [],
    },
  ];
  const s2 = {
    [S2_FILES.observationPrep]: `${JSON.stringify({
      status: "frozen-before-observation",
      placeholders: [],
      boundFiles: [],
      setupReadings: { source: { pins } },
    })}\n`,
    [S2_FILES.declarationAddendum]: `${JSON.stringify({ declarations: [] })}\n`,
    [S2_FILES.g01Addendum]: `${JSON.stringify({ declarations: [] })}\n`,
  };
  for (const [file, text] of Object.entries(s2)) write(repo, file, text);
  write(repo, procedureFilePath("v1"), procedureText({ draft }));
  write(
    repo,
    OBSERVATION_PREP_RECORD_PATH,
    `${JSON.stringify({
      schemaVersion: OBSERVATION_PREP_RECORD_SCHEMA,
      graphRuntimeObservedBeforeFreeze: false,
      k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
      graphCaseFreeze: { ...GRAPH_CASE_FREEZE },
      g01Fixture: { path: G01_FIXTURE.path, sha256: G01_FIXTURE.sha256 },
      boundFiles: Object.fromEntries(
        Object.entries(s2)
          .filter(([file]) => file !== unbind)
          .map(([file, text]) => [file, sha256(text)]),
      ),
    })}\n`,
  );
  const prep = commit(repo, "S4", [
    ...Object.values(S2_FILES),
    procedureFilePath("v1"),
    OBSERVATION_PREP_RECORD_PATH,
  ]);
  testGit(repo, "update-ref", "refs/remotes/origin/master", prep);
  const freeze = {
    ...K64_FREEZE,
    sha256: sha256("K6/4 frozen text\n"),
    freezeCommit,
  };
  return { repo, freezeCommit, prep, freeze };
}

function input(fixture, extra = {}) {
  return {
    root: fixture.repo,
    candidate: fixture.prep,
    prepCommit: fixture.prep,
    k62Commit: "k62",
    k64Commit: fixture.freezeCommit,
    buildReceipt: { kind: "eval" },
    productReceipt: { kind: "product" },
    defaultAddonSha256: "0".repeat(64),
    ...extra,
  };
}

function stub() {
  const calls = [];
  return {
    calls,
    admitGraphCase: (value) => {
      calls.push(value);
      return Object.freeze({ stub: true, candidateHead: value.candidateHead });
    },
  };
}

test("DR-CP4-N-1 (1): 正式の admission は候補・K6/4（注入の descriptor）・S4 の S2・pin・手順の v1 を確かめてから admitGraphCaseRun に凍結の fixture 8 本を渡す", () => {
  const fixture = repository();
  try {
    const { calls, admitGraphCase } = stub();
    const admitted = admitFormalK64Run(input(fixture), {
      freeze: fixture.freeze,
      admitGraphCase,
    });
    assert.equal(admitted.candidate.commit, fixture.prep);
    assert.equal(admitted.k64.freezeCommit, fixture.freezeCommit);
    assert.equal(admitted.s2.commit, fixture.prep);
    assert.deepEqual(Object.keys(admitted.s2.files), [
      "observationPrep",
      "declarationAddendum",
      "g01Addendum",
    ]);
    assert.equal(admitted.procedure.commit, fixture.prep);
    assert.equal(admitted.procedure.purpose, "formal");
    assert.deepEqual(
      admitted.pins.map((row) => [row.role, row.check]),
      [
        ["harness", "bytes"],
        ["fix", "ancestor"],
      ],
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].candidateHead, fixture.prep);
    assert.equal(calls[0].prepCommit, fixture.prep);
    assert.deepEqual(
      calls[0].fixtures.map((row) => row.path).sort(),
      Object.keys(FROZEN_FIXTURE_SHA256).sort(),
    );
    // An admission another entry made never reads a frozen fixture.
    assert.throws(
      () =>
        readAdmittedFixture(admitted.admission, {
          root: REPO_ROOT,
          path: "evals/nir1-graph/g02-directed-relation.v1.json",
        }),
      /admitGraphCaseRun/u,
    );
    // The real admitGraphCaseRun is the default dependency.
    assert.throws(
      () => admitFormalK64Run(input(fixture), { freeze: fixture.freeze }),
      /\[precheck\]/u,
    );
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test("DR-CP4-N-1 (1): 候補が clean でない・HEAD が候補でない・K6/4 の凍結が無い／違うときは S2 を読む前に [precheck]", () => {
  const fixture = repository();
  try {
    const { calls, admitGraphCase } = stub();
    const deps = { freeze: fixture.freeze, admitGraphCase };
    assert.throws(
      () => admitFormalK64Run(input(fixture, { candidate: "HEAD" }), deps),
      /full commit sha/u,
    );
    assert.throws(
      () =>
        admitFormalK64Run(
          input(fixture, { candidate: fixture.freezeCommit }),
          deps,
        ),
      /is not the fixed candidate/u,
    );
    writeFileSync(path.join(fixture.repo, "stray.txt"), "x");
    assert.throws(() => admitFormalK64Run(input(fixture), deps), /not clean/u);
    rmSync(path.join(fixture.repo, "stray.txt"));
    assert.throws(
      () =>
        admitFormalK64Run(input(fixture), {
          ...deps,
          freeze: { ...fixture.freeze, freezeCommit: null },
        }),
      /not pinned/u,
    );
    // K6/4 before S2: an S4 commit without the S2 files still stops at K6/4.
    assert.throws(
      () =>
        admitFormalK64Run(
          input(fixture, { prepCommit: fixture.freezeCommit }),
          {
            ...deps,
            freeze: { ...fixture.freeze, freezeCommit: null },
          },
        ),
      /not pinned/u,
    );
    assert.throws(
      () =>
        admitFormalK64Run(input(fixture, { k64Commit: fixture.prep }), deps),
      /K6\/4 freeze commit or bytes differ/u,
    );
    assert.throws(
      () => admitFormalK64Run(input(fixture), { admitGraphCase }),
      /K6\/4/u,
    );
    assert.throws(
      () =>
        admitFormalK64Run(
          input(fixture, { prepCommit: fixture.freezeCommit }),
          deps,
        ),
      /cannot be read from the S4 commit/u,
    );
    assert.throws(
      () => admitFormalK64Run({ ...input(fixture), extra: 1 }, deps),
      /unsupported option/u,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test("S2 追補 #2／#3: bytes の pin の file が違う、ancestor の pin が祖先でない、S2 の file が候補で変わった、手順が draft なら [precheck]", () => {
  const bad = repository({ pinSha: "f".repeat(64) });
  const unrelated = repository({ ancestor: "a".repeat(40) });
  const draft = repository({ draft: true });
  const moved = repository();
  try {
    const run = (fixture, extra = {}) => {
      const { admitGraphCase } = stub();
      return () =>
        admitFormalK64Run(input(fixture, extra), {
          freeze: fixture.freeze,
          admitGraphCase,
        });
    };
    assert.throws(run(bad), /is not the bytes the harness pin/u);
    assert.throws(run(unrelated), /as an ancestor/u);
    assert.throws(
      run(draft),
      /draft must be true for a draft-<N> version and false for v<N>/u,
    );
    write(moved.repo, S2_FILES.declarationAddendum, "{}\n");
    const head = commit(moved.repo, "later", [S2_FILES.declarationAddendum]);
    assert.throws(
      run(moved, { candidate: head }),
      /differs between the S4 commit and the candidate/u,
    );
    // A worktree byte that differs from the candidate's (not clean) also
    // stops; a pin row without files is refused.
    assert.throws(
      () =>
        assertSourcePins({
          root: moved.repo,
          candidate: head,
          pins: [
            {
              role: "x",
              commit: moved.freezeCommit,
              check: "bytes",
              files: [],
            },
          ],
        }),
      /neither a bytes pin/u,
    );
    assert.throws(
      () => assertSourcePins({ root: moved.repo, candidate: head, pins: [] }),
      /is empty/u,
    );
  } finally {
    for (const row of [bad, unrelated, draft, moved])
      rmSync(row.repo, { recursive: true, force: true });
  }
});

test("DR-CP4-S4-1: A の S2 の file は S4 の freeze record が束縛した bytes だけ（束縛が無ければ [precheck]、admitGraphCaseRun を呼ばない）", () => {
  for (const file of Object.values(S2_FILES)) {
    const fixture = repository({ unbind: file });
    try {
      const { calls, admitGraphCase } = stub();
      assert.throws(
        () =>
          admitFormalK64Run(input(fixture), {
            freeze: fixture.freeze,
            admitGraphCase,
          }),
        new RegExp(
          `\\[precheck\\].*the freeze record does not bind ${file.replaceAll(".", "\\.")}`,
          "u",
        ),
      );
      assert.equal(calls.length, 0);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  }
});

test("レビュー P2-6、再レビュー P2-1／P2-2: 台帳は名前ごとに 1 回、全件を列挙し、Gold が使う parity は開始より前に完了した 1 つに固定（未完了・止まった・blocked を含む・2 つ以上は [precheck]）", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cp4-s5a-attempts-"));
  try {
    const entry = (runKind, extra = {}) => ({
      candidate: { commit: "b".repeat(40), tree: "c".repeat(40) },
      s4Commit: "d".repeat(40),
      runKind,
      startedAtUtc: "2026-10-28T01:00:00.000Z",
      setups: {},
      ...extra,
    });
    const key = { root, candidate: "b".repeat(40), s4Commit: "d".repeat(40) };
    const parityOf = () => listAttempts({ ...key, runKind: "parity" });
    const later = "9999-01-01T00:00:00.000Z";
    assert.throws(
      () => selectParity({ attempts: parityOf(), startedAtUtc: later }),
      /no completed unrestricted parity run/u,
    );
    const started = startAttempt({
      root,
      runName: "p0",
      entry: entry("parity"),
    });
    assert.match(started.fileSha256, /^[0-9a-f]{64}$/u);
    assert.throws(
      () => startAttempt({ root, runName: "p0", entry: entry("parity") }),
      /already attempted/u,
    );
    assert.throws(
      () => startAttempt({ root, runName: "x", entry: entry("other") }),
      /run kind/u,
    );
    // Started, stopped or blocked parity attempts never admit a Gold run.
    assert.throws(
      () => selectParity({ attempts: parityOf(), startedAtUtc: later }),
      /no completed/u,
    );
    finishAttempt({ file: started.file, status: "stopped" });
    const blocked = startAttempt({
      root,
      runName: "p1",
      entry: entry("parity", { startedAtUtc: "2026-10-28T02:00:00.000Z" }),
    });
    finishAttempt({ file: blocked.file, status: "incomplete-blocked" });
    assert.throws(
      () => selectParity({ attempts: parityOf(), startedAtUtc: later }),
      /no completed/u,
    );
    const done = startAttempt({
      root,
      runName: "p2",
      entry: entry("parity", { startedAtUtc: "2026-10-28T03:00:00.000Z" }),
    });
    finishAttempt({ file: done.file, status: "completed" });
    const chosen = selectParity({ attempts: parityOf(), startedAtUtc: later });
    assert.equal(chosen.used, "p2");
    // Every parity attempt is disclosed, with its status and file digest.
    assert.deepEqual(
      chosen.attempts.map((row) => [row.runName, row.status]),
      [
        ["p0", "stopped"],
        ["p1", "incomplete-blocked"],
        ["p2", "completed"],
      ],
    );
    assert.ok(
      chosen.attempts.every((row) => /^[0-9a-f]{64}$/u.test(row.fileSha256)),
    );
    // A parity that finished after the Gold run started does not count.
    assert.throws(
      () =>
        selectParity({
          attempts: parityOf(),
          startedAtUtc: "2000-01-01T00:00:00.000Z",
        }),
      /no completed/u,
    );
    // A second completed parity: which one is used is not chosen later.
    const again = startAttempt({
      root,
      runName: "p3",
      entry: entry("parity", { startedAtUtc: "2026-10-28T04:00:00.000Z" }),
    });
    finishAttempt({ file: again.file, status: "completed" });
    assert.throws(
      () => selectParity({ attempts: parityOf(), startedAtUtc: later }),
      /2 completed parity runs/u,
    );
    for (const name of ["g1", "g2", "g3"])
      startAttempt({ root, runName: name, entry: entry("gold") });
    startAttempt({
      root,
      runName: "other-candidate",
      entry: entry("gold", { candidate: { commit: "e".repeat(40) } }),
    });
    writeFileSync(path.join(root, ATTEMPTS_DIR, "broken.json"), "{");
    assert.deepEqual(
      listAttempts({ ...key, runKind: "gold" }).map(
        (row) => row.runName ?? row.unreadable,
      ),
      ["broken.json", "g1", "g2", "g3"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("再レビュー P2-1: 試行は blocked の variant を含めば completed にならない（incomplete-blocked）。誤りや問題があれば stopped", () => {
  const ok = { status: "measured", valid: true };
  assert.equal(
    attemptStatusOf({ problems: [], variants: { a: ok, b: ok } }),
    "completed",
  );
  assert.equal(
    attemptStatusOf({
      problems: [],
      variants: { a: ok, b: { status: "blocked", valid: true } },
    }),
    "incomplete-blocked",
  );
  assert.equal(
    attemptStatusOf({
      problems: [],
      variants: { a: { status: "blocked-at-setup", valid: true } },
    }),
    "incomplete-blocked",
  );
  assert.equal(
    attemptStatusOf({ problems: ["x"], variants: { a: ok } }),
    "stopped",
  );
  assert.equal(
    attemptStatusOf({
      problems: [],
      variants: { a: { status: "measured", valid: false } },
    }),
    "stopped",
  );
  assert.equal(attemptStatusOf({ problems: [], variants: {} }), "stopped");
});
