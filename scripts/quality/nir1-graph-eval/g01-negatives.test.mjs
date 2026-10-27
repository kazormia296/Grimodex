// DR-CP4-O-1 (5): K24-G01-N2〜N4 の段の Electron を使わない部分。偽の page
// （製品の writer の代わり）と注入した Index の metadata で、宣言の前の版の用意、
// 宣言の後の mutation、B の seal の待ち、SP-P1 の照合し直し、blocked を確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessG01Negative } from "./frozen-diagnostics.mjs";
import {
  G01_CONTROL_ATTEMPTS,
  G01_CONTROL_GAP_MS,
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

test("O-1 (5): mutation の後は setup と同じ規則（新しい B の generation が dirty でなく、Chronicle が使える）で待ち、上限は B_SEAL_WAIT_MS", async () => {
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
  // Chronicle の Index が dirty なら使えない。
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
  assert.equal(chronicleDirty.ok, false);
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
      value: { before: { sha256: "o" }, after: { sha256: "o" } },
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
    "undetermined",
  );
});

test("O-6: 対照は graph-ready になるまで上限の回数だけ製品の fetch を繰り返し、答えと Graph の入力の digest を残す", async () => {
  const answers = [
    reachedAnswer({ graphOutcome: "graph-late", graphOnly: null }),
    reachedAnswer(),
  ];
  const { calls, page } = fakePage({
    graphProbe: () => ({ ok: true, value: answers.shift() }),
  });
  const slept = [];
  const control = await runG01NegativeControl({
    page,
    ids: IDS,
    target: T2,
    readGraphInputs: () => ({ codexRelations: [{ id: "r" }] }),
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(control.status, "reached");
  assert.equal(control.answers.length, 2);
  assert.deepEqual(slept, [G01_CONTROL_GAP_MS]);
  assert.deepEqual(calls[0], [
    "graphProbe",
    { sceneId: "s-query", seed: "e-orin" },
  ]);
  assert.equal(
    control.graphInputs,
    graphInputsDigest({ codexRelations: [{ id: "r" }] }),
  );
  const never = fakePage({
    graphProbe: () => ({
      ok: true,
      value: reachedAnswer({ graphOutcome: "graph-late" }),
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
  assert.equal(late.answers.length, G01_CONTROL_ATTEMPTS);
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
    readIndex: () => metadata(4),
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
  ]);
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
    openSession: async () => ({ close: async () => {} }),
    readIndex: () => metadata(4),
    before: metadata(4),
    wait: async () => ({ ok: false, waitedMs: B_SEAL_WAIT_MS }),
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.sealAttempts.length, 1 + B_SEAL_REOPENS);
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
