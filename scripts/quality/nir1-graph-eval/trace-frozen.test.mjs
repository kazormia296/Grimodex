// DR-CP4-O-1 (6): 凍結した trace の配線の Electron を使わない部分。注入した
// admission、観測前の記録、trace の file、受領書で、admission の束、receipt の
// 先頭、setupFailure、論理→runtime、試行の履歴、開始時の封印の開示を確かめる。
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { devTracePlan } from "./trace-record.mjs";
import {
  TRACE_PROJECT,
  frozenTraceRuntime,
  measureCdpNow,
  prepareFrozenTrace,
  readTraceDeclaration,
  readTraceSetup,
  setupFailureReceipt,
  startSealReceipt,
  traceAttemptHistory,
  traceSeedPinCheck,
} from "./trace-frozen.mjs";
import { COMPLETE_SETUP_FIELDS } from "./test-support.mjs";
import { s2Record } from "./s5b-test-support.mjs";

const H = (c) => c.repeat(64);
const C = (c) => c.repeat(40);

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "s5b-trace-"));
}

const G02 = TRACE_PROJECT;

function setupReceipt(overrides = {}) {
  return {
    schemaVersion: "nir1-cp4-frozen-setup/1",
    stopsAt: "complete",
    status: "setup-complete",
    fixture: {
      kind: "frozen",
      caseId: "G-02",
      variantId: "base",
      path: G02.fixturePath,
      sha256: H("c"),
    },
    logicalToRuntime: {
      projectId: "p-rt",
      querySceneId: "g02-query",
      scenes: { "g02-query": "q-rt", "g02-harbor": "h-rt" },
      entities: { "g02-orla": "orla-rt" },
      typedRevisions: {
        "g02-r-tamsin": { revisionId: "rev-tamsin-rt" },
        "g02-r-sela": { revisionId: "rev-sela-rt" },
      },
    },
    coldDatabase: { path: "cold/grimodex.db", sha256: H("d") },
    candidate: { commit: C("b"), tree: "t-b", clean: true },
    ...COMPLETE_SETUP_FIELDS,
    ...overrides,
  };
}

function writeReceipt(dir, value, name = "setup-receipt.json") {
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

test("O-1 (6): G-02 base の完全な setup は complete、上限内の開き直しで届かなければ setupFailure（(b) は未測定、HOLD、差し替えなし）", () => {
  const dir = tempDir();
  const complete = readTraceSetup({
    root: dir,
    file: writeReceipt(dir, setupReceipt()),
  });
  assert.equal(complete.kind, "complete");
  assert.equal(complete.setup.caseId, "G-02");
  const blocked = readTraceSetup({
    root: dir,
    file: writeReceipt(
      dir,
      setupReceipt({
        status: "blocked",
        blocked: {
          harnessId: "b-seal-not-published",
          condition: "any",
          contractBlockedId: "b-sealed-binding",
          hold: false,
          precheck: false,
        },
        sealAttempts: [
          { session: "seal", attempt: 0, outcome: "not-published" },
          { session: "seal", attempt: 1, outcome: "not-published" },
          { session: "seal", attempt: 2, outcome: "not-published" },
        ],
      }),
      "blocked.json",
    ),
  });
  assert.equal(blocked.kind, "setup-failure");
  assert.deepEqual(
    {
      project: blocked.setupFailure.project,
      b: blocked.setupFailure.b,
      cp4Availability: blocked.setupFailure.cp4Availability,
      projectSwapAllowed: blocked.setupFailure.projectSwapAllowed,
      harnessId: blocked.setupFailure.blocked.harnessId,
      condition: blocked.setupFailure.blocked.condition,
      sealOpenings: blocked.setupFailure.openings.seal,
    },
    {
      project: "G-02/base",
      b: "unmeasured",
      cp4Availability: "HOLD",
      projectSwapAllowed: false,
      harnessId: "b-seal-not-published",
      condition: "any",
      sealOpenings: 3,
    },
  );
  // 上限を超えた開き直しの記録は受領書の誤り。
  assert.throws(
    () =>
      readTraceSetup({
        root: dir,
        file: writeReceipt(
          dir,
          setupReceipt({
            status: "blocked",
            blocked: { harnessId: "b-seal-not-published", condition: "any" },
            sealAttempts: [0, 1, 2, 3].map((attempt) => ({
              session: "seal",
              attempt,
              outcome: "not-published",
            })),
          }),
          "over.json",
        ),
      }),
    /\[artifact\]/u,
  );
  // blocked の名前の無い止まり方、failed、別の case、① の受領書は [precheck]。
  for (const [name, value] of [
    ["plain", setupReceipt({ status: "blocked" })],
    ["failed", setupReceipt({ status: "failed" })],
    ["problems", setupReceipt({ status: "setup-with-problems" })],
    [
      "other",
      setupReceipt({
        fixture: { ...setupReceipt().fixture, caseId: "G-03" },
      }),
    ],
    [
      "variant",
      setupReceipt({
        fixture: { ...setupReceipt().fixture, variantId: "v2" },
      }),
    ],
    [
      "seed-pin",
      setupReceipt({ stopsAt: "seed-pin", status: "setup-through-seed-pin" }),
    ],
    ["dev", setupReceipt({ schemaVersion: "nir1-cp4-dev-setup/1" })],
    ["branch", setupReceipt({ status: "sp-p4-branch-complete" })],
  ])
    assert.throws(
      () =>
        readTraceSetup({
          root: dir,
          file: writeReceipt(dir, value, `${name}.json`),
        }),
      /\[precheck\]/u,
      name,
    );
});

function frozenPlan(kind) {
  const plan = devTracePlan({
    kind,
    cycles: 2,
    querySceneId: "g02-query",
    otherSceneId: "g02-harbor",
    seedEntityId: "g02-orla",
    materials: ["g02-r-tamsin", "g02-r-sela"],
  });
  return {
    ...plan,
    project: { caseId: "G-02", variantId: "base", fixtureSha256: H("c") },
  };
}

test("O-1 (6): trace の file の論理 ID を setup の受領書で runtime に写し、欠ければ [precheck]", () => {
  for (const kind of ["editing", "browsing"]) {
    const runtime = frozenTraceRuntime({
      plan: frozenPlan(kind),
      setupRaw: setupReceipt(),
    });
    assert.equal(runtime.ids.querySceneId, "q-rt");
    assert.equal(runtime.ids.projectId, "p-rt");
    assert.equal(runtime.seed, "orla-rt");
    assert.deepEqual(runtime.materials, ["rev-tamsin-rt", "rev-sela-rt"]);
    assert.deepEqual(runtime.revisions, {
      "g02-r-tamsin": "rev-tamsin-rt",
      "g02-r-sela": "rev-sela-rt",
    });
  }
  const without = setupReceipt();
  delete without.logicalToRuntime.typedRevisions["g02-r-sela"];
  assert.throws(
    () =>
      frozenTraceRuntime({ plan: frozenPlan("editing"), setupRaw: without }),
    /\[precheck\].*g02-r-sela/u,
  );
  const noHarbor = setupReceipt();
  delete noHarbor.logicalToRuntime.scenes["g02-harbor"];
  assert.throws(
    () =>
      frozenTraceRuntime({ plan: frozenPlan("browsing"), setupRaw: noHarbor }),
    /\[precheck\].*g02-harbor/u,
  );
  // trace の project は setup の fixture と同じ bytes。
  assert.throws(
    () =>
      frozenTraceRuntime({
        plan: {
          ...frozenPlan("editing"),
          project: { caseId: "G-02", variantId: "base", fixtureSha256: H("e") },
        },
        setupRaw: setupReceipt(),
      }),
    /\[precheck\]/u,
  );
});

const identity = {
  path: "evals/nir1-graph/trace-editing.v1.json",
  sha256: H("1"),
  commit: C("a"),
};

function previous(attempt, outcome, overrides = {}) {
  return {
    sha256: H(String(attempt)),
    receipt: {
      runId: `trace-${attempt}`,
      attempt,
      trace: { ...identity },
      stalled:
        outcome === "completed"
          ? null
          : { seq: 3, op: "edit", reason: "no-autosave-commit" },
      attemptOutcome: outcome,
      ...overrides,
    },
  };
}

test("O-1 (6): --attempt の履歴は同じ trace の file の前の試行の receipt で確かめ、2 回目の stall は [precheck]", () => {
  assert.deepEqual(
    traceAttemptHistory({
      attempt: 1,
      attemptLimit: 2,
      previous: [],
      identity,
    }),
    [],
  );
  const history = traceAttemptHistory({
    attempt: 2,
    attemptLimit: 2,
    previous: [previous(1, "retake")],
    identity,
  });
  assert.deepEqual(history, [
    {
      attempt: 1,
      runId: "trace-1",
      receiptSha256: H("1"),
      stalled: { seq: 3, op: "edit", reason: "no-autosave-commit" },
      attemptOutcome: "retake",
    },
  ]);
  for (const [label, input] of [
    ["previous missing", { attempt: 2, previous: [] }],
    ["completed before", { attempt: 2, previous: [previous(1, "completed")] }],
    [
      "other file",
      {
        attempt: 2,
        previous: [
          previous(1, "retake", { trace: { ...identity, sha256: H("9") } }),
        ],
      },
    ],
    ["numbering", { attempt: 2, previous: [previous(2, "retake")] }],
    [
      "over limit",
      {
        attempt: 3,
        previous: [previous(1, "retake"), previous(2, "precheck")],
      },
    ],
    ["extra", { attempt: 1, previous: [previous(1, "retake")] }],
  ])
    assert.throws(
      () => traceAttemptHistory({ attemptLimit: 2, identity, ...input }),
      /\[precheck\]/u,
      label,
    );
});

test("O-1 (6): startSeal.receipt は seal-read の時刻と回数、CDP の now() の往復を開示する", async () => {
  const log = [
    {
      op: "seal-read",
      phase: "before",
      index: 0,
      at: 10,
      finishedAt: 11.5,
      read: { ok: true },
    },
    { op: "open-scene", index: 0 },
    {
      op: "seal-read",
      phase: "after",
      index: 0,
      at: 20,
      finishedAt: 20.5,
      read: { ok: true },
    },
    {
      op: "seal-read",
      phase: "before",
      index: 1,
      at: 30,
      finishedAt: 31,
      read: { ok: false },
    },
  ];
  let t = 0;
  const cdp = await measureCdpNow(async () => 1, {
    count: 5,
    clock: () => (t += 2),
  });
  assert.equal(cdp.length, 5);
  assert.ok(cdp.every((ms) => ms === 2));
  const receipt = startSealReceipt({ log, cdpNowMs: cdp });
  assert.equal(receipt.total, 3);
  assert.deepEqual(receipt.countByQuery, { 0: 2, 1: 1 });
  assert.deepEqual(receipt.reads[0], {
    index: 0,
    phase: "before",
    startedAt: 10,
    finishedAt: 11.5,
    durationMs: 1.5,
  });
  assert.deepEqual(receipt.cdpNow, {
    clock: "renderer performance.now() through CDP (driver.now())",
    samples: 5,
    roundTripMs: { min: 2, median: 2, max: 2 },
  });
});

test("O-1 (6): trace の workspace の R5 は SP-P1 と同じ 1 行の照合（問いの Scene の pin が 1 つで seed）", () => {
  const read = (pins) => ({
    sceneLive: true,
    pins,
    source: { db: { path: "/w/db", ino: 1 } },
  });
  const pin = (entryId) => ({
    entryId,
    entryInProject: true,
    createdAt: "2026-10-28T00:00:00Z",
  });
  const setupRaw = setupReceipt();
  const plan = frozenPlan("editing");
  assert.equal(
    traceSeedPinCheck({ plan, setupRaw, read: read([pin("orla-rt")]) }).status,
    "match",
  );
  for (const pins of [[], [pin("other")], [pin("orla-rt"), pin("other")]])
    assert.throws(
      () => traceSeedPinCheck({ plan, setupRaw, read: read(pins) }),
      /\[precheck\] R5/u,
    );
});

function fakeDeps(overrides = {}) {
  const calls = [];
  const record = s2Record();
  const base = {
    readK64Head: (input) => {
      calls.push(["k64", input.commit]);
      return { freezeCommit: C("4"), sha256: H("4") };
    },
    admit: (input) => {
      calls.push(["admit", input.prepCommit, input.fixtures]);
      return {
        kind: "graph-case",
        candidateHead: C("b"),
        ratification5: { sealed: true },
        head: {
          k62: { freezeCommit: C("6"), sha256: H("6") },
          k64: { freezeCommit: C("4"), sha256: H("4") },
          observationPrep: { commit: C("5"), freezeRecordSha256: H("5") },
        },
      };
    },
    collectFacts: (input) => {
      calls.push(["facts", input.commit]);
      return { record };
    },
    readTraceHeads: ({ traces }) => {
      calls.push(["trace-heads"]);
      return traces.map(({ kind, path: file, commit, sha256 }) => ({
        kind,
        path: file,
        commit,
        sha256,
      }));
    },
    loadPlan: ({ file, commit }) => {
      calls.push(["plan", file, commit]);
      return {
        plan: frozenPlan(file.includes("editing") ? "editing" : "browsing"),
        path: file,
        commit,
        sha256: file.includes("editing") ? H("1") : H("2"),
      };
    },
    loadProcedure: (input) => {
      calls.push(["procedure", input.version, input.commit, input.purpose]);
      return { values: { tShowMs: 2000 } };
    },
    readPrevious: () => [],
    readTree: (commit) => {
      calls.push(["tree", commit]);
      return "t-b";
    },
    claimAttempt: (input) => {
      calls.push(["claim", input.kind, input.key]);
      return { claimed: true };
    },
    readSpP4: (input) => {
      calls.push(["sp-p4", input.candidateCommit]);
      return { summary: { status: "passed" }, receiptSha256: H("8") };
    },
    readDeclaration: () => {
      calls.push(["declaration"]);
      return {
        sceneId: "g02-query",
        addendum: { path: "a", commit: C("5"), sha256: H("5") },
      };
    },
    now: () => new Date("2026-10-28T00:00:00.000Z"),
  };
  return { calls, deps: { ...base, ...overrides } };
}

const inputs = {
  buildReceipt: { candidate: {} },
  productReceipt: { candidate: {} },
  defaultAddonSha256: H("a"),
};

test("O-1 (6): 凍結の trace の準備は K6/4 の head → admission → 先頭の書込み → plan の順で、どれかが欠ければ測定を始めない", async () => {
  const dir = tempDir();
  const setupFile = writeReceipt(dir, setupReceipt());
  const options = {
    setup: setupFile,
    "trace-kind": "editing",
    "prep-commit": C("5"),
    "k62-commit": C("6"),
    "k64-commit": C("4"),
    "procedure-version": "v1",
    "sp-p4-receipt": "sp-p4-receipt.json",
    attempt: "1",
  };
  const { calls, deps } = fakeDeps();
  const prepared = await prepareFrozenTrace({
    root: dir,
    runDir: dir,
    options,
    inputs,
    deps,
  });
  assert.equal(prepared.setupFailure, null);
  assert.deepEqual(
    calls.map((row) => row[0]),
    [
      "k64",
      "admit",
      "tree",
      "facts",
      "trace-heads",
      "claim",
      "sp-p4",
      "plan",
      "declaration",
      "procedure",
    ],
  );
  // admission は setup の fixture（G-02 base の凍結の path と sha256）で。
  assert.deepEqual(calls[1][2], [{ path: G02.fixturePath, sha256: H("c") }]);
  // 手順の file は S4 の commit から正式の版で読む。
  assert.deepEqual(calls.at(-1), ["procedure", "v1", C("5"), "formal"]);
  const head = JSON.parse(readFileSync(path.join(dir, "head.json"), "utf8"));
  assert.equal(head.kind, "trace");
  assert.equal(head.runStartedAtUtc, "2026-10-28T00:00:00.000Z");
  assert.equal(head.traces.length, 2);
  assert.equal(prepared.headSha256.length, 64);
  assert.equal(prepared.identity.sha256, H("1"));
  assert.equal(prepared.runtime.ids.querySceneId, "q-rt");
  assert.equal(prepared.declaration.sceneId, "g02-query");
  assert.deepEqual(calls[6], ["sp-p4", C("b")]);
  // レビュー P2-c: 台帳の key は run 名でなく trace の file と候補の identity。
  assert.deepEqual(calls[5], [
    "claim",
    "trace",
    `trace:evals/nir1-graph/trace-editing.v1.json:${C("a")}:${H("1")}:${C("b")}`,
  ]);
  // ④ の SP-P4 の receipt が無ければ起動しない。
  const fifth = tempDir();
  const noSpP4 = fakeDeps();
  await assert.rejects(
    prepareFrozenTrace({
      root: fifth,
      runDir: fifth,
      options: {
        ...options,
        setup: writeReceipt(fifth, setupReceipt()),
        "sp-p4-receipt": undefined,
      },
      inputs,
      deps: noSpP4.deps,
    }),
    /\[precheck\].*SP-P4/u,
  );
  assert.ok(!noSpP4.calls.some((row) => row[0] === "plan"));
  // trace の file の bytes が S2 の sha256 と違えば [precheck]。
  const other = tempDir();
  await assert.rejects(
    prepareFrozenTrace({
      root: other,
      runDir: other,
      options: { ...options, setup: writeReceipt(other, setupReceipt()) },
      inputs,
      deps: fakeDeps({
        loadPlan: ({ file, commit }) => ({
          plan: frozenPlan("editing"),
          path: file,
          commit,
          sha256: H("7"),
        }),
      }).deps,
    }),
    /\[precheck\]/u,
  );
  // placeholder の trace は先頭で止まり、plan も手順も読まない。
  const third = tempDir();
  const placeholder = fakeDeps({
    collectFacts: () => ({
      record: s2Record((r) => {
        r.traces[0].commit = "S4:trace-editing-commit";
        return r;
      }),
    }),
    readTraceHeads: ({ traces }) => {
      if (traces.some((row) => !/^[0-9a-f]{40}$/u.test(row.commit)))
        throw new Error("[precheck] S5-B traces: not filled");
      return traces;
    },
  });
  await assert.rejects(
    prepareFrozenTrace({
      root: third,
      runDir: third,
      options: { ...options, setup: writeReceipt(third, setupReceipt()) },
      inputs,
      deps: placeholder.deps,
    }),
    /\[precheck\]/u,
  );
  assert.ok(!placeholder.calls.some((row) => row[0] === "plan"));
  // 凍結の commit が無ければ admission の前に止まる。
  const fourth = tempDir();
  const noK64 = fakeDeps({
    readK64Head: () => {
      throw new Error("[precheck] the K6/4 freeze commit is not given");
    },
  });
  await assert.rejects(
    prepareFrozenTrace({
      root: fourth,
      runDir: fourth,
      options: { ...options, setup: writeReceipt(fourth, setupReceipt()) },
      inputs,
      deps: noK64.deps,
    }),
    /\[precheck\]/u,
  );
  assert.deepEqual(noK64.calls, []);
});

test("O-1 (6): G-02 base が setup-complete に届かなければ、先頭を書いた後に setupFailure を返し plan も手順も読まない", async () => {
  const dir = tempDir();
  const setupFile = writeReceipt(
    dir,
    setupReceipt({
      status: "blocked",
      blocked: {
        harnessId: "maintenance-enabled",
        condition: "maintenance-wait-exhausted",
      },
      maintenanceAttempts: [0, 1, 2].map((attempt) => ({
        attempt,
        outcome: "timeout",
      })),
    }),
  );
  const { calls, deps } = fakeDeps();
  const prepared = await prepareFrozenTrace({
    root: dir,
    runDir: dir,
    options: {
      setup: setupFile,
      "trace-kind": "browsing",
      "prep-commit": C("5"),
      "k62-commit": C("6"),
      "k64-commit": C("4"),
      attempt: "1",
    },
    inputs,
    deps,
  });
  assert.equal(prepared.setupFailure.b, "unmeasured");
  assert.ok(
    !calls.some((row) =>
      ["plan", "procedure", "declaration", "sp-p4"].includes(row[0]),
    ),
  );
  const receipt = setupFailureReceipt({
    runId: "t",
    kind: "browsing",
    prepared,
    candidate: { commit: C("b") },
  });
  assert.equal(receipt.status, "unmeasured");
  assert.equal(receipt.cp4Availability, "HOLD");
  assert.equal(receipt.preview, false);
  assert.equal(receipt.head.kind, "trace");
  assert.equal(receipt.setupFailure.blocked.harnessId, "maintenance-enabled");
  assert.equal(receipt.queries, undefined);
});

test("O-1 (6): trace の宣言の Scene は観測前の記録の boundFiles の addendum から G-02 base の 1 行を読む", () => {
  const addendum = (declarations) => () => ({
    path: "evals/nir1-graph/declaration-addendum.v1.json",
    commit: C("5"),
    sha256: H("5"),
    bytes: Buffer.from(JSON.stringify({ declarations })),
  });
  const rows = [
    { caseId: "G-02", variantId: "base", sceneId: "g02-tamsin-first" },
    { caseId: "G-07", variantId: "base", sceneId: "g07-pell-dock" },
  ];
  assert.equal(
    readTraceDeclaration({ root: "/r", record: {}, read: addendum(rows) })
      .sceneId,
    "g02-tamsin-first",
  );
  assert.throws(
    () =>
      readTraceDeclaration({
        root: "/r",
        record: {},
        read: addendum(rows.slice(1)),
      }),
    /\[precheck\]/u,
  );
  assert.throws(
    () =>
      readTraceDeclaration({
        root: "/r",
        record: {},
        read: addendum([rows[0], rows[0]]),
      }),
    /\[precheck\]/u,
  );
});

test("レビュー P2-2: trace の setup は SP-P4 の分岐・R5 の照合の受領書を拒み、今の候補の commit と tree で走ったものだけ", async () => {
  const dir = tempDir();
  for (const [name, value] of [
    [
      "branch",
      setupReceipt({
        status: "blocked",
        blocked: { harnessId: "b-seal-not-published", condition: "any" },
        seedPinBranch: { stage: "side", side: "without-seed-pin-step" },
      }),
    ],
    ["r5", setupReceipt({ r5CheckRun: { id: "r" } })],
  ])
    assert.throws(
      () =>
        readTraceSetup({
          root: dir,
          file: writeReceipt(dir, value, `${name}.json`),
        }),
      /\[precheck\].*SP-P4 branch or an R5 check/u,
      name,
    );
  const options = {
    "trace-kind": "editing",
    "prep-commit": C("5"),
    "k62-commit": C("6"),
    "k64-commit": C("4"),
    "sp-p4-receipt": "x.json",
    attempt: "1",
  };
  for (const candidate of [
    { commit: C("c"), tree: "t-b" },
    { commit: C("b"), tree: "t-x" },
    undefined,
  ]) {
    const run = tempDir();
    const deps = fakeDeps();
    await assert.rejects(
      prepareFrozenTrace({
        root: run,
        runDir: run,
        options: {
          ...options,
          setup: writeReceipt(run, setupReceipt({ candidate })),
        },
        inputs,
        deps: deps.deps,
      }),
      /\[precheck\].*another candidate/u,
    );
    assert.ok(!deps.calls.some((row) => row[0] === "facts"));
  }
  // setupFailure の受領書も今の候補のものだけ。
  const run = tempDir();
  await assert.rejects(
    prepareFrozenTrace({
      root: run,
      runDir: run,
      options: {
        ...options,
        setup: writeReceipt(
          run,
          setupReceipt({
            status: "blocked",
            blocked: { harnessId: "b-seal-not-published", condition: "any" },
            candidate: { commit: C("c"), tree: "t-b" },
          }),
        ),
      },
      inputs,
      deps: fakeDeps().deps,
    }),
    /another candidate/u,
  );
});

test("レビュー P3 (e): 凍結の trace は試行の台帳（A の #754）が繋がるまで始めない", async () => {
  const run = tempDir();
  const { deps } = fakeDeps({ claimAttempt: undefined });
  delete deps.claimAttempt;
  await assert.rejects(
    prepareFrozenTrace({
      root: run,
      runDir: run,
      options: {
        setup: writeReceipt(run, setupReceipt()),
        "trace-kind": "editing",
        "prep-commit": C("5"),
        "k62-commit": C("6"),
        "k64-commit": C("4"),
        "sp-p4-receipt": "x.json",
        attempt: "1",
      },
      inputs,
      deps,
    }),
    /\[precheck\].*ledger/u,
  );
});

test("レビュー P3: 試行の上限は trace の file の stall.attemptLimit（2）で、3 回目は前の 2 回が取り直しでも始めない", async () => {
  const run = tempDir();
  const retake = (attempt) => ({
    sha256: H(String(attempt)),
    receipt: {
      runId: `t-${attempt}`,
      attempt,
      trace: {
        path: "evals/nir1-graph/trace-editing.v1.json",
        sha256: H("1"),
        commit: C("a"),
      },
      stalled: { seq: 1, op: "edit", reason: "x" },
      attemptOutcome: "retake",
    },
  });
  const { deps } = fakeDeps({ readPrevious: () => [retake(1), retake(2)] });
  await assert.rejects(
    prepareFrozenTrace({
      root: run,
      runDir: run,
      options: {
        setup: writeReceipt(run, setupReceipt()),
        "trace-kind": "editing",
        "prep-commit": C("5"),
        "k62-commit": C("6"),
        "k64-commit": C("4"),
        "sp-p4-receipt": "x.json",
        attempt: "3",
      },
      inputs,
      deps,
    }),
    /\[precheck\].*--attempt must be an integer from 1 to 2/u,
  );
});
