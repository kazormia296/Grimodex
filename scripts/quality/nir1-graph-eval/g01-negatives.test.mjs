// DR-CP4-O-1 (5): K24-G01-N2〜N4 の段の Electron を使わない部分。偽の page
// （製品の writer の代わり）と注入した Index の metadata で、宣言の前の版の用意、
// 宣言の後の mutation、B の seal の待ち、SP-P1 の照合し直し、blocked を確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessG01Negative } from "./frozen-diagnostics.mjs";
import {
  G01_CONTROL_ATTEMPTS,
  G01_SAMPLE_ATTEMPTS,
  answerKindOf,
  askUntilDecided,
  assertG01RetryFixed,
  G01_CONTROL_GAP_MS,
  G01_GRAPH_READY_WAIT_MS,
  effectiveAnswerOf,
  G01_NEGATIVE_POLL_MS,
  classifyG01Control,
  g01FrameReached,
  graphInputsDigest,
  reopenUntilSealed,
  runG01NegativeControl,
  g01NegativeLaunchEnv,
  g01NegativeSampleOf,
  prepareG01NegativeBeforeDeclaration,
  runG01NegativeStep,
  waitG01NegativeSealed,
} from "./g01-negatives.mjs";
import { B_SEAL_REOPENS, B_SEAL_WAIT_MS } from "./frozen-setup-driver.mjs";
import { TRACE_MAINTENANCE_SEAM } from "./trace-record.mjs";

const TARGET = {
  sceneId: "g01-mira",
  entityId: "g01-mira-entity",
  seedEntityId: "g01-orin",
  querySceneId: "g01-query",
};
const IDS = {
  projectId: "p",
  scenes: {
    "g01-mira": "s-mira",
    "g01-query": "s-query",
    "g01-review": "s-review",
  },
  entities: { "g01-orin": "e-orin", "g01-mira-entity": "e-mira" },
};

function fakePage(handlers) {
  const calls = [];
  const diagnostic = new Proxy(
    {},
    {
      get: (_, name) => async (input) => {
        calls.push([name, input]);
        return handlers[name](input);
      },
    },
  );
  globalThis.window = { cp4Harness: { diagnostic } };
  return { calls, page: { evaluate: async (fn, arg) => fn(arg) } };
}

const metadata = (b, dirty = false, chronicle = 3) => ({
  b: { generation: b, dirty },
  chronicle: { generation: chronicle, dirty: false },
});

test("O-1 (5): 宣言の前に N3 は同じ bytes の版、N4 は Draft の版と元の本文の再保存を用意し、N2 は何もしない", async () => {
  const { calls, page } = fakePage({
    sameBytesVersion: () => ({
      ok: true,
      value: { revisionId: "v1", created: true, sha256: "s" },
    }),
    draftThenOriginal: (input) => ({
      ok: true,
      value: {
        revisionId: "v2",
        draftSha256: `d${input.suffix}`,
        originalSha256: "o",
        afterSha256: "o",
      },
    }),
  });
  assert.deepEqual(
    await prepareG01NegativeBeforeDeclaration({
      id: "K24-G01-N2",
      page,
      ids: IDS,
      target: TARGET,
    }),
    { prepared: null, blocked: null },
  );
  const n3 = await prepareG01NegativeBeforeDeclaration({
    id: "K24-G01-N3",
    page,
    ids: IDS,
    target: TARGET,
  });
  assert.equal(n3.prepared.revisionId, "v1");
  const n4 = await prepareG01NegativeBeforeDeclaration({
    id: "K24-G01-N4",
    page,
    ids: IDS,
    target: TARGET,
  });
  assert.equal(n4.prepared.draftSha256, "d Draft.");
  assert.deepEqual(
    calls.map((row) => row[0]),
    ["sameBytesVersion", "draftThenOriginal"],
  );
  assert.deepEqual(calls[1][1], {
    projectId: "p",
    sceneId: "s-mira",
    suffix: " Draft.",
  });
  // 作れなければ blocked（数えない）。
  const failing = fakePage({
    sameBytesVersion: () => ({ ok: false, error: "no version" }),
    draftThenOriginal: () => ({
      ok: true,
      value: {
        revisionId: "v",
        draftSha256: "d",
        originalSha256: "o",
        afterSha256: "d",
      },
    }),
  });
  assert.equal(
    (
      await prepareG01NegativeBeforeDeclaration({
        id: "K24-G01-N3",
        page: failing.page,
        ids: IDS,
        target: TARGET,
      })
    ).blocked.reason,
    "before-declaration",
  );
  assert.equal(
    (
      await prepareG01NegativeBeforeDeclaration({
        id: "K24-G01-N4",
        page: failing.page,
        ids: IDS,
        target: TARGET,
      })
    ).blocked.reason,
    "before-declaration",
  );
  await assert.rejects(
    prepareG01NegativeBeforeDeclaration({
      id: "K24-G01-N1",
      page,
      ids: IDS,
      target: TARGET,
    }),
    /\[precheck\]/u,
  );
});

test("O-1 (5): mutation の後は setup の b-seal と同じ規則（新しい B の generation が dirty でない）で待ち、上限は B_SEAL_WAIT_MS", async () => {
  let clock = 0;
  const reads = [metadata(4, true), metadata(5, true), metadata(5, false)];
  const ok = await waitG01NegativeSealed({
    readIndex: () => reads.shift() ?? metadata(5, false),
    before: metadata(4),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.waitedMs, 2 * G01_NEGATIVE_POLL_MS);
  // generation が進まなければ（clean のままでも）上限で blocked。
  clock = 0;
  const stuck = await waitG01NegativeSealed({
    readIndex: () => metadata(4, false),
    before: metadata(4),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.waitedMs, B_SEAL_WAIT_MS);
  // B の規則だけで待つ（Chronicle は開き直しの後に query の経路で作る）。
  clock = 0;
  const chronicleDirty = await waitG01NegativeSealed({
    readIndex: () => ({
      b: { generation: 6, dirty: false },
      chronicle: { generation: 3, dirty: true },
    }),
    before: metadata(4),
    limitMs: 1000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(chronicleDirty.ok, true);
});

const pin = (entryId) => ({
  entryId,
  entryInProject: true,
  createdAt: "2026-10-28T00:00:00Z",
});
const pins = (rows) => ({
  sceneLive: true,
  pins: rows,
  source: { db: { path: "/w", ino: 1 } },
});

test("O-1 (5): 宣言の後の mutation は N2 が同じ本文の再保存、N3／N4 が用意した版の restore、その後に待ちと SP-P1 の照合し直し", async () => {
  const { calls, page } = fakePage({
    resaveBody: () => ({
      ok: true,
      value: {
        before: { sha256: "o", version: 3 },
        after: { sha256: "o", version: 4 },
      },
    }),
    restoreVersion: (input) => ({
      ok: true,
      value: {
        revisionId: input.revisionId,
        restoredSha256: input.revisionId === "v1" ? "o" : "d",
        afterSha256: input.revisionId === "v1" ? "o" : "d",
      },
    }),
  });
  const base = {
    page,
    ids: IDS,
    target: TARGET,
    readIndex: () => metadata(4),
    readPins: () => pins([pin("e-orin")]),
    reopen: async () => ({
      ok: true,
      session: { id: "s2" },
      sealAttempts: [{ attempt: 0, outcome: "sealed" }],
    }),
    readGraphInputs: () => ({ codexRelations: [] }),
    closeCurrent: async () => {},
    openSession: async () => ({}),
  };
  const n2 = await runG01NegativeStep({
    ...base,
    id: "K24-G01-N2",
    before: null,
  });
  assert.equal(n2.blocked, null);
  assert.equal(n2.spP1Recheck.status, "match");
  // 開き直した session と記録を返す。
  assert.deepEqual(n2.session, { id: "s2" });
  assert.equal(n2.sealAttempts[0].outcome, "sealed");
  assert.equal(n2.graphInputs.length, 64);
  const n3 = await runG01NegativeStep({
    ...base,
    id: "K24-G01-N3",
    before: { revisionId: "v1", sha256: "o" },
  });
  assert.equal(n3.blocked, null);
  const n4 = await runG01NegativeStep({
    ...base,
    id: "K24-G01-N4",
    before: { revisionId: "v2", draftSha256: "d", originalSha256: "o" },
  });
  assert.equal(n4.blocked, null);
  assert.deepEqual(
    calls.map((row) => row[0]),
    ["resaveBody", "restoreVersion", "restoreVersion"],
  );
  // project の snapshot の restore は呼ばない（入口が無い）。
  assert.ok(!calls.some((row) => /snapshot/iu.test(row[0])));
  // SP-P1 が合わなければ照合の記録が mismatch（結果は inconclusive）。
  const moved = await runG01NegativeStep({
    ...base,
    id: "K24-G01-N2",
    before: null,
    readPins: () =>
      pins([
        pin("e-orin"),
        { ...pin("e-mira"), createdAt: "2026-10-28T00:00:01Z" },
      ]),
  });
  assert.equal(moved.spP1Recheck.status, "multiple-pins");
  assert.equal(
    assessG01Negative({
      id: "K24-G01-N2",
      spP1Recheck: moved.spP1Recheck,
      samples: [],
    }).outcome,
    "inconclusive",
  );
});

test("O-1 (5): restore の経路が使えない、版の bytes が違う、B が戻らなければ blocked（case の判定に数えない）", async () => {
  const cases = [
    [
      { restoreVersion: () => ({ ok: false, error: "restore unavailable" }) },
      "K24-G01-N3",
      { revisionId: "v1", sha256: "o" },
      "mutation",
    ],
    [
      {
        restoreVersion: () => ({
          ok: true,
          value: { restoredSha256: "x", afterSha256: "x" },
        }),
      },
      "K24-G01-N3",
      { revisionId: "v1", sha256: "o" },
      "mutation",
    ],
    [
      {
        restoreVersion: () => ({
          ok: true,
          value: { restoredSha256: "o", afterSha256: "o" },
        }),
      },
      "K24-G01-N4",
      { revisionId: "v2", draftSha256: "d" },
      "mutation",
    ],
    [
      {
        resaveBody: () => ({
          ok: true,
          value: { before: { sha256: "o" }, after: { sha256: "p" } },
        }),
      },
      "K24-G01-N2",
      null,
      "mutation",
    ],
    [{}, "K24-G01-N3", null, "mutation"],
  ];
  for (const [handlers, id, before, reason] of cases) {
    const { page } = fakePage(handlers);
    const step = await runG01NegativeStep({
      id,
      page,
      ids: IDS,
      target: TARGET,
      before,
      readIndex: () => metadata(4),
      readPins: () => pins([pin("e-orin")]),
      reopen: async () => ({
        ok: true,
        session: { id: "s2" },
        sealAttempts: [{ attempt: 0, outcome: "sealed" }],
      }),
      readGraphInputs: () => ({ codexRelations: [] }),
      closeCurrent: async () => {},
      openSession: async () => ({}),
    });
    assert.equal(step.blocked?.reason, reason, id);
    assert.equal(
      assessG01Negative({ id, blocked: step.blocked }).outcome,
      "blocked",
    );
  }
  const { page } = fakePage({
    resaveBody: () => ({
      ok: true,
      value: {
        before: { sha256: "o", version: 1 },
        after: { sha256: "o", version: 2 },
      },
    }),
  });
  const notSealed = await runG01NegativeStep({
    id: "K24-G01-N2",
    page,
    ids: IDS,
    target: TARGET,
    before: null,
    readIndex: () => metadata(4),
    readPins: () => pins([pin("e-orin")]),
    readGraphInputs: () => ({}),
    reopen: async () => ({
      ok: false,
      session: null,
      sealAttempts: [0, 1, 2].map((attempt) => ({
        attempt,
        outcome: "not-published",
        waitedMs: B_SEAL_WAIT_MS,
      })),
    }),
  });
  assert.equal(notSealed.blocked.reason, "b-seal-not-published");
  assert.equal(notSealed.blocked.openings, 3);
  assert.equal(notSealed.session, null);
});

test("O-1 (5): 測定の Main は B-ROUTE の journey seam、sample は論理 ID（対照が無ければ届いたかは判定不能）", () => {
  const env = g01NegativeLaunchEnv({
    nonce: "8c7f4a3e-6b1d-4c2a-9e5f-0a1b2c3d4e5f",
    base: { CI: "true" },
  });
  assert.equal(
    env[TRACE_MAINTENANCE_SEAM.triggerEnv],
    TRACE_MAINTENANCE_SEAM.trigger,
  );
  const sample = g01NegativeSampleOf({
    row: {
      phase: "measured",
      repeat: 2,
      arm: "graph",
      followUp: { parent: { seed: "e-orin" } },
      finalSceneIds: ["s-review", "zz"],
    },
    ids: IDS,
  });
  assert.deepEqual(sample, {
    phase: "measured",
    repeat: 2,
    arm: "graph",
    seedRequested: "g01-orin",
    frameReached: null,
    returnedSceneIds: ["g01-review", "unmapped:zz"],
  });
  assert.deepEqual(
    assessG01Negative({
      id: "K24-G01-N4",
      spP1Recheck: { status: "match" },
      samples: [sample],
    }).reasons,
    ["g01-mira-entity-reached:undetermined"],
  );
});

test("O-1 (5)（変異 G4）: restore の答えの版の bytes が用意した版と違えば、本文が一致して見えても blocked", async () => {
  const { page } = fakePage({
    restoreVersion: () => ({
      ok: true,
      value: { restoredSha256: "other", afterSha256: "o" },
    }),
  });
  const step = await runG01NegativeStep({
    id: "K24-G01-N3",
    page,
    ids: IDS,
    target: TARGET,
    before: { revisionId: "v1", sha256: "o" },
    readIndex: () => metadata(4),
    readPins: () => pins([pin("e-orin")]),
    reopen: async () => ({
      ok: true,
      session: { id: "s2" },
      sealAttempts: [{ attempt: 0, outcome: "sealed" }],
    }),
    readGraphInputs: () => ({ codexRelations: [] }),
    closeCurrent: async () => {},
    openSession: async () => ({}),
  });
  assert.equal(step.blocked?.reason, "mutation");
});

test("O-1 (5): K24-G01-N2〜N4 の段の dev の予告は dev preview の目的に登録されている", async () => {
  const { DEV_PREVIEW_PURPOSES } = await import("./admission.mjs");
  const { G01_NEGATIVE_PREVIEW_PURPOSE } =
    await import("./g01-negative-preview.mjs");
  assert.ok(DEV_PREVIEW_PURPOSES.includes(G01_NEGATIVE_PREVIEW_PURPOSE));
});

const T2 = { ...TARGET };
const reachedAnswer = (overrides = {}) => ({
  status: "completed",
  graphOutcome: "graph-ready",
  graphOnly: {
    sceneId: "s-mira",
    pinEntityId: "e-mira",
    hop: 1,
    edges: [{ from: "e-orin", to: "e-mira", relationType: "delivered-key-to" }],
  },
  pathAttachments: [],
  ...overrides,
});

test("O-6: 対照は graph-ready の答えの Graph-only の行が宣言の Scene・pin の Entity・seed からの edge を持てば reached、持たなければ not-reached、ほかは undetermined", () => {
  const classify = (answer) =>
    classifyG01Control({ answer, ids: IDS, target: T2 });
  assert.equal(classify(reachedAnswer()), "reached");
  assert.equal(classify(reachedAnswer({ graphOnly: null })), "not-reached");
  assert.equal(
    classify(
      reachedAnswer({
        graphOnly: { ...reachedAnswer().graphOnly, pinEntityId: "e-orin" },
      }),
    ),
    "not-reached",
  );
  assert.equal(
    classify(
      reachedAnswer({
        graphOnly: { ...reachedAnswer().graphOnly, sceneId: "s-review" },
      }),
    ),
    "not-reached",
  );
  assert.equal(
    classify(
      reachedAnswer({
        graphOnly: {
          ...reachedAnswer().graphOnly,
          edges: [{ from: "e-x", to: "e-mira" }],
        },
      }),
    ),
    "not-reached",
  );
  assert.equal(
    classify(reachedAnswer({ graphOutcome: "graph-late" })),
    "undetermined",
  );
  assert.equal(
    classify(reachedAnswer({ graphOutcome: "graph-unavailable:failed" })),
    "not-reached",
  );
});

test("O-1 (7): mutation の後は Main を閉じて開き直し、setup の seal の session と同じ上限（1 + B_SEAL_REOPENS 回）で B を待ち、記録を残す", async () => {
  const events = [];
  let opened = 0;
  const openSession = async ({ attempt, dirLabel }) => {
    events.push(["open", attempt, dirLabel]);
    opened += 1;
    return { close: async () => events.push(["close", attempt]) };
  };
  const sealedAt = 2;
  const result = await reopenUntilSealed({
    closeCurrent: async () => events.push(["close-current"]),
    openSession,
    buildChronicle: async () => {
      events.push(["chronicle"]);
      return { ok: true };
    },
    readIndex: () => (opened === sealedAt ? metadata(5) : metadata(4)),
    before: metadata(4),
    wait: async () =>
      opened === sealedAt
        ? { ok: true, waitedMs: 5, metadata: metadata(5) }
        : { ok: false, waitedMs: B_SEAL_WAIT_MS, metadata: metadata(4, true) },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    ["close-current"],
    ["open", 0, "measure-reopen-0"],
    ["close", 0],
    ["open", 1, "measure-reopen-1"],
    ["chronicle"],
  ]);
  assert.equal(result.sealAttempts[1].chronicle.usable, true);
  assert.deepEqual(
    result.sealAttempts.map((row) => [row.attempt, row.outcome, row.published]),
    [
      [0, "not-published", false],
      [1, "sealed", true],
    ],
  );
  opened = 0;
  const exhausted = await reopenUntilSealed({
    closeCurrent: async () => {},
    buildChronicle: async () => ({ ok: true }),
    openSession: async () => ({ close: async () => {} }),
    readIndex: () => metadata(4),
    before: metadata(4),
    wait: async () => ({ ok: false, waitedMs: B_SEAL_WAIT_MS }),
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.sealAttempts.length, 1 + B_SEAL_REOPENS);
  assert.equal(exhausted.reason, "b-seal-not-published");
  // B は封印されたが Chronicle が使えなければ開き直さずに止める（setup の
  // index-build-timeout と同じ）。
  let opens = 0;
  const chronicleDirty = await reopenUntilSealed({
    closeCurrent: async () => {},
    buildChronicle: async () => ({ ok: false }),
    openSession: async () => {
      opens += 1;
      return { close: async () => {} };
    },
    readIndex: () => ({
      b: { generation: 5, dirty: false },
      chronicle: { generation: 3, dirty: true },
    }),
    before: metadata(4),
    wait: async () => ({ ok: true, waitedMs: 1 }),
  });
  assert.equal(chronicleDirty.ok, false);
  assert.equal(chronicleDirty.reason, "chronicle-index-not-usable");
  assert.equal(opens, 1);
});

test("O-6: sample の「届いた」は、対照が reached・Graph の入力が同じ・seed つき・graph-ready・A3 eligible のときだけ真", () => {
  const control = { status: "reached", graphInputs: "d1" };
  const row = (overrides = {}) => ({
    phase: "measured",
    repeat: 0,
    arm: "graph",
    followUp: { parent: { seed: "e-orin" }, child: { outcome: "graph-ready" } },
    graph: { outcome: "graph-late" },
    a3AtStart: { eligible: true },
    ...overrides,
  });
  const reached = (value, extra = {}) =>
    g01FrameReached({
      row: value,
      ids: IDS,
      target: T2,
      control,
      inputsDigest: "d1",
      ...extra,
    });
  assert.equal(reached(row()), true);
  assert.equal(reached(row({ followUp: { parent: { seed: "e-x" } } })), false);
  assert.equal(reached(row({ a3AtStart: { eligible: false } })), false);
  assert.equal(reached(row({ a3AtStart: null })), null);
  assert.equal(
    reached(
      row({
        followUp: { parent: { seed: "e-orin" } },
        graph: { outcome: "graph-unavailable" },
      }),
    ),
    false,
  );
  assert.equal(
    reached(row({ followUp: { parent: { seed: "e-orin" } } })),
    null,
  );
  assert.equal(reached(row(), { inputsDigest: "d2" }), null);
  assert.equal(
    reached(row(), { control: { status: "not-reached", graphInputs: "d1" } }),
    null,
  );
  assert.equal(reached(row(), { control: null }), null);
  // 結果: 届いて g01-mira が返らなければ established、返れば not-established。
  const sample = g01NegativeSampleOf({
    row: { ...row(), finalSceneIds: ["s-review"] },
    ids: IDS,
    target: T2,
    control,
    inputsDigest: "d1",
  });
  assert.equal(sample.frameReached, true);
  assert.equal(
    assessG01Negative({
      id: "K24-G01-N2",
      spP1Recheck: { status: "match" },
      samples: [sample],
    }).outcome,
    "established",
  );
  const returned = g01NegativeSampleOf({
    row: { ...row(), finalSceneIds: ["s-mira"] },
    ids: IDS,
    target: T2,
    control,
    inputsDigest: "d1",
  });
  assert.equal(
    assessG01Negative({
      id: "K24-G01-N2",
      spP1Recheck: { status: "match" },
      samples: [returned],
    }).outcome,
    "not-established",
  );
});

test("レビュー P2-3: 対照は hook と同じく親と、親が late なら graph-ready の印の後の follow-up の子の答えで取り、各回の owner の counter を残す", async () => {
  const probes = [
    {
      parent: reachedAnswer({ graphOutcome: "graph-late", graphOnly: null }),
      child: null,
      readyMarkAfterMs: null,
    },
    {
      parent: reachedAnswer({ graphOutcome: "graph-late", graphOnly: null }),
      child: reachedAnswer(),
      readyMarkAfterMs: 900,
    },
  ];
  const { calls, page } = fakePage({
    graphProbe: () => ({ ok: true, value: probes.shift() }),
  });
  let begins = 0;
  const slept = [];
  const control = await runG01NegativeControl({
    page,
    ids: IDS,
    target: T2,
    readGraphInputs: () => ({ codexRelations: [{ id: "r" }] }),
    readCounters: async () => ({
      begins: (begins += 1),
      cacheHits: begins,
      lateCached: 0,
    }),
    readIndex: () => metadata(4),
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(control.status, "reached");
  assert.equal(control.tries.length, 2);
  assert.equal(control.decidedAt, 1);
  assert.deepEqual(slept, [G01_CONTROL_GAP_MS]);
  assert.deepEqual(calls[0], [
    "graphProbe",
    {
      projectId: "p",
      sceneId: "s-query",
      seed: "e-orin",
      readyWaitMs: G01_GRAPH_READY_WAIT_MS,
    },
  ]);
  assert.deepEqual(control.tries[1].counters, {
    begins: 1,
    cacheHits: 1,
    lateCached: 0,
  });
  assert.equal(
    control.graphInputs,
    graphInputsDigest({ codexRelations: [{ id: "r" }] }),
  );
  // 開示: B の index の metadata と、対照が覆わないこと。
  assert.deepEqual(control.bIndex, metadata(4).b);
  assert.match(control.limit, /B index digest is disclosed, not compared/u);
  assert.equal(effectiveAnswerOf({ parent: { a: 1 }, child: null }).a, 1);
  assert.equal(effectiveAnswerOf({ parent: { a: 1 }, child: { a: 2 } }).a, 2);
  const never = fakePage({
    graphProbe: () => ({
      ok: true,
      value: {
        parent: reachedAnswer({ graphOutcome: "graph-late" }),
        child: null,
      },
    }),
  });
  const late = await runG01NegativeControl({
    page: never.page,
    ids: IDS,
    target: T2,
    readGraphInputs: () => ({}),
    sleep: async () => {},
  });
  assert.equal(late.status, "undetermined");
  assert.equal(late.tries.length, G01_CONTROL_ATTEMPTS);
  assert.equal(G01_CONTROL_ATTEMPTS, 60);
  assert.equal(G01_SAMPLE_ATTEMPTS, 60);
});

test("レビュー P3 (a)(b): seal の後に B が再び dirty なら開き直し、Chronicle が使えなければ止め、N2 は版が進まなければ blocked", async () => {
  let opened = 0;
  const dirtyThenClean = await reopenUntilSealed({
    closeCurrent: async () => {},
    buildChronicle: async () => ({ ok: true }),
    openSession: async () => {
      opened += 1;
      return { close: async () => {} };
    },
    readIndex: () =>
      opened === 1
        ? {
            b: { generation: 5, dirty: true },
            chronicle: { generation: 3, dirty: false },
          }
        : {
            b: { generation: 6, dirty: false },
            chronicle: { generation: 3, dirty: false },
          },
    before: metadata(4),
    wait: async () => ({ ok: true, waitedMs: 1 }),
  });
  assert.equal(dirtyThenClean.ok, true);
  assert.deepEqual(
    dirtyThenClean.sealAttempts.map((row) => row.outcome),
    ["sealed-then-dirty", "sealed"],
  );
  const chronicleDirty = await reopenUntilSealed({
    closeCurrent: async () => {},
    buildChronicle: async () => ({ ok: true }),
    openSession: async () => ({ close: async () => {} }),
    readIndex: () => ({
      b: { generation: 5, dirty: false },
      chronicle: { generation: 3, dirty: true },
    }),
    before: metadata(4),
    wait: async () => ({ ok: true, waitedMs: 1 }),
  });
  assert.equal(chronicleDirty.reason, "chronicle-index-not-usable");
  const { page } = fakePage({
    resaveBody: () => ({
      ok: true,
      value: {
        before: { sha256: "o", version: 3 },
        after: { sha256: "o", version: 3 },
      },
    }),
  });
  const step = await runG01NegativeStep({
    id: "K24-G01-N2",
    page,
    ids: IDS,
    target: TARGET,
    before: null,
    readIndex: () => metadata(4),
    readPins: () => pins([pin("e-orin")]),
    readGraphInputs: () => ({}),
    reopen: async () => ({ ok: true, session: {}, sealAttempts: [] }),
  });
  assert.equal(step.blocked.reason, "mutation");
  assert.match(step.blocked.error, /did not advance the body version/u);
});

test("O-14: 中立の答え（late）だけを聞き直し、最初に決まった答えで判定する（best-of ではない）。上限まで決まらなければ決まらない。全回を記録する", async () => {
  assert.equal(answerKindOf({ graphOutcome: "graph-ready" }), "ready");
  assert.equal(
    answerKindOf({ graphOutcome: "graph-unavailable:invalidated" }),
    "unavailable",
  );
  assert.equal(answerKindOf({ graphOutcome: "graph-late" }), "neutral");
  assert.equal(answerKindOf(null), "neutral");
  const run = async (outcomes, limit = 30) => {
    const queue = [...outcomes];
    const slept = [];
    let clock = 0;
    let begins = 0;
    const result = await askUntilDecided({
      ask: async () => {
        clock += 7;
        const outcome = queue.shift() ?? "graph-late";
        return {
          parent: { graphOutcome: "graph-late" },
          child: { graphOutcome: outcome },
        };
      },
      limit,
      readCounters: async () => ({
        begins: (begins += 1),
        cacheHits: begins,
        lateCached: 0,
      }),
      sleep: async (ms) => slept.push(ms),
      clock: () => clock,
    });
    return { result, slept };
  };
  const first = await run([
    "graph-late",
    "graph-late",
    "graph-unavailable:invalidated",
    "graph-ready",
  ]);
  assert.equal(first.result.decided, true);
  // 最初に決まった答え（unavailable）が決める。後の ready は聞かない。
  assert.equal(first.result.kind, "unavailable");
  assert.equal(first.result.tries.length, 3);
  assert.deepEqual(first.slept, [G01_CONTROL_GAP_MS, G01_CONTROL_GAP_MS]);
  assert.equal(G01_CONTROL_GAP_MS, 250);
  assert.deepEqual(
    first.result.tries.map((row) => [
      row.at,
      row.kind,
      row.durationMs,
      row.cached,
    ]),
    [
      [0, "neutral", 7, true],
      [1, "neutral", 7, true],
      [2, "unavailable", 7, true],
    ],
  );
  assert.deepEqual(first.result.tries[0].counters, {
    begins: 1,
    cacheHits: 1,
    lateCached: 0,
  });
  const never = await run([], G01_SAMPLE_ATTEMPTS);
  assert.equal(never.result.decided, false);
  assert.equal(never.result.tries.length, 60);
  assert.equal(never.slept.length, 59);
  // 対照は決まった unavailable を not-reached と読む（届かない）。
  const { page } = fakePage({
    graphProbe: () => ({
      ok: true,
      value: {
        parent: reachedAnswer({
          graphOutcome: "graph-unavailable:failed",
          graphOnly: null,
        }),
        child: null,
      },
    }),
  });
  const control = await runG01NegativeControl({
    page,
    ids: IDS,
    target: T2,
    readGraphInputs: () => ({}),
    sleep: async () => {},
  });
  assert.deepEqual(
    [control.status, control.decided, control.tries.length],
    ["not-reached", true, 1],
  );
});

test("レビュー P2-a: 親が決まった答えなら子を見ずに親で読む（親 unavailable → 子 ready は届かない、親 late → 子 ready は届いた）", () => {
  const control = { status: "reached", graphInputs: "d1" };
  const row = (parent, child) => ({
    phase: "measured",
    repeat: 0,
    arm: "graph",
    seed: "e-orin",
    graph: { outcome: parent },
    followUp: {
      parent: { seed: "e-orin" },
      child: child ? { outcome: child } : null,
    },
    a3AtStart: { eligible: true },
  });
  const reached = (value) =>
    g01FrameReached({
      row: value,
      ids: IDS,
      target: T2,
      control,
      inputsDigest: "d1",
    });
  assert.equal(reached(row("graph-unavailable", "graph-ready")), false);
  assert.equal(reached(row("graph-ready", "graph-unavailable")), true);
  assert.equal(reached(row("graph-late", "graph-ready")), true);
  assert.equal(reached(row("graph-late", "graph-late")), null);
  assert.equal(reached(row("graph-late", null)), null);
  assert.equal(
    effectiveAnswerOf({
      parent: { graphOutcome: "graph-unavailable:failed" },
      child: { graphOutcome: "graph-ready" },
    }).graphOutcome,
    "graph-unavailable:failed",
  );
  assert.equal(
    effectiveAnswerOf({
      parent: { graphOutcome: "graph-late" },
      child: { graphOutcome: "graph-ready" },
    }).graphOutcome,
    "graph-ready",
  );
});

test("レビュー P3: 対照と sample の聞き直しの上限と間隔は記録し、定数と違えば止める", async () => {
  const { page } = fakePage({
    graphProbe: () => ({
      ok: true,
      value: { parent: reachedAnswer(), child: null },
    }),
  });
  const control = await runG01NegativeControl({
    page,
    ids: IDS,
    target: T2,
    readGraphInputs: () => ({}),
    sleep: async () => {},
  });
  assert.deepEqual(control.retry, {
    limit: G01_CONTROL_ATTEMPTS,
    gapMs: G01_CONTROL_GAP_MS,
  });
  const sampleRetry = { limit: G01_SAMPLE_ATTEMPTS, gapMs: G01_CONTROL_GAP_MS };
  assert.ok(
    assertG01RetryFixed({
      control,
      samples: [{ repeat: 0, retry: sampleRetry }],
    }),
  );
  const shortControl = await runG01NegativeControl({
    page,
    ids: IDS,
    target: T2,
    readGraphInputs: () => ({}),
    sleep: async () => {},
    attempts: 3,
  });
  assert.throws(
    () => assertG01RetryFixed({ control: shortControl }),
    /\[precheck\].*control/u,
  );
  assert.throws(
    () =>
      assertG01RetryFixed({
        control,
        samples: [{ repeat: 1, retry: { limit: 5, gapMs: 250 } }],
      }),
    /\[precheck\].*sample 1/u,
  );
  const sample = g01NegativeSampleOf({
    row: { phase: "measured", repeat: 0, arm: "graph" },
    ids: IDS,
    retry: sampleRetry,
  });
  assert.deepEqual(sample.retry, sampleRetry);
});

test("レビュー P3（変異 X5）: 間隔が定数と違っても止める", () => {
  const control = { retry: { limit: G01_CONTROL_ATTEMPTS, gapMs: 1000 } };
  assert.throws(
    () => assertG01RetryFixed({ control }),
    /\[precheck\].*control/u,
  );
});

test("integrator の決定: 聞き直しの上限は対照・sample とも 60 回、間隔 250 ms で、上限 30 の記録は止める", () => {
  assert.deepEqual(
    assertG01RetryFixed({
      control: { retry: { limit: 60, gapMs: 250 } },
      samples: [{ repeat: 0, retry: { limit: 60, gapMs: 250 } }],
    }),
    {
      control: { limit: 60, gapMs: 250 },
      sample: { limit: 60, gapMs: 250 },
    },
  );
  assert.throws(
    () =>
      assertG01RetryFixed({ control: { retry: { limit: 30, gapMs: 250 } } }),
    /\[precheck\].*control/u,
  );
  assert.throws(
    () =>
      assertG01RetryFixed({
        control: { retry: { limit: 60, gapMs: 250 } },
        samples: [{ repeat: 2, retry: { limit: 30, gapMs: 250 } }],
      }),
    /\[precheck\].*sample 2/u,
  );
});
