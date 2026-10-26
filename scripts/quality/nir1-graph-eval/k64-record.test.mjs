// R7 の記録の producer（S1f）。renderer の hook の消費者の観測（合成）と Native の
// 記録・counter から、分類器（followup.mjs）が読む記録を作れることを、分類の結果で
// 確かめる。値はすべて合成（H5／RS-JOIN の形を真似た時刻）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFollowUp, missingR7 } from "./followup.mjs";
import {
  K64_RUNNER_KIND,
  buildFollowUpRecord,
  k64GraphSampleRow,
  r1Record,
  r2Record,
  summarizeQ4,
} from "./k64-record.mjs";

const SEED = "entity-seed";
const SCENE = "scene-q";

function result(overrides = {}) {
  const { timing = {}, ...rest } = overrides;
  return {
    status: "completed",
    rawStatus: "completed",
    resultKind: "fused",
    irStatus: "available",
    irReason: null,
    completion: { outcome: "ir-ready", deadlineExceeded: false },
    graphOutcome: "graph-late",
    graph: null,
    initialSnapshot: { indexUsable: true, querySupported: true },
    rawSceneIds: ["dev-a", "dev-b"],
    irSceneIds: ["dev-c"],
    finalSceneIds: ["dev-a", "dev-b", "dev-c"],
    ...rest,
    timing: {
      tFetchMs: 50,
      tRawReadyMs: 100,
      tReturnMs: 110.9,
      refreshTrigger: null,
      graphWindowMs: 10.840000000596048,
      native: { rawReadyElapsedMs: 40, firstSnapshotElapsedMs: 5 },
      ...timing,
    },
  };
}

const CHILD_RESULT = {
  graphOutcome: "graph-ready",
  graph: {
    edgeCount: 2,
    graphOnlySceneId: "dev-added",
    pathAttachmentSceneIds: ["dev-b"],
  },
  finalSceneIds: ["dev-a", "dev-b", "dev-c", "dev-added"],
  timing: {
    tFetchMs: 118,
    tRawReadyMs: 125,
    tReturnMs: 145,
    refreshTrigger: "graph-ready",
    graphWindowMs: 100,
  },
};

const api = (cmd, calledAt, resolvedAt, extra = {}) => ({
  cmd,
  calledAt,
  resolvedAt,
  ok: true,
  settle: null,
  status: null,
  reason: null,
  ...extra,
});

/** One D′ sample: parent graph-late, one notice, a Cached child within W_f. */
function observation({ parent = {}, child = {}, ...rest } = {}) {
  return {
    endReason: "child-published",
    mountedAt: 0,
    endedAt: 146.5,
    fetches: [
      {
        seq: 1,
        sceneId: SCENE,
        queryGeneration: 41,
        refreshTrigger: null,
        seed: SEED,
        rawOnly: false,
        calledAt: 50,
        resolvedAt: 111,
        result: result(),
        ...parent,
      },
      ...(child === null
        ? []
        : [
            {
              seq: 2,
              sceneId: SCENE,
              queryGeneration: 43,
              refreshTrigger: "graph-ready",
              seed: SEED,
              rawOnly: false,
              calledAt: 118,
              resolvedAt: 146,
              result: result(CHILD_RESULT),
              ...child,
            },
          ]),
    ],
    commits: [
      { at: 111.5, fetchSeq: 1, loading: false, display: "parent" },
      { at: 117.5, fetchSeq: 1, loading: true, display: "parent" },
      ...(child === null
        ? []
        : [{ at: 146, fetchSeq: 2, loading: false, display: "child" }]),
    ],
    notices: child === null ? [] : [{ kind: "graph-ready", at: 117 }],
    api: [
      api("related_scenes_begin", 60, 80),
      api("related_scenes_continue", 100.5, 103),
      api("related_scenes_graph_continue", 100.5, 130, {
        status: "unavailable",
        reason: "cancelled",
      }),
      api("related_scenes_graph_continue", 110.85, 112, { settle: "unused" }),
      ...(child === null
        ? []
        : [
            api("related_scenes_begin", 118.5, 120),
            api("related_scenes_continue", 125.2, 131),
            api("related_scenes_graph_continue", 125.2, 139, {
              status: "available",
            }),
            api("related_scenes_graph_continue", 145, 146, { settle: "used" }),
          ]),
    ],
    ...rest,
  };
}

function nativeRecord(overrides = {}) {
  return {
    seq: 1,
    tBeginNs: 1_000_000,
    tReturnedNs: 2_000_000,
    startSlot: {
      kind: "empty",
      readyFresh: false,
      preparesReady: 3,
      readyGeneration: 3,
    },
    cacheOccupiedAtBegin: false,
    begin: "pending",
    reason: null,
    busyCause: null,
    ticket: {
      tTicketNs: 1_500_000,
      settled: true,
      tSettledNs: 21_000_000,
      outcome: "available",
      reason: null,
      disposition: "unused",
      busyCause: null,
      freshnessStamp: {
        attemptedAtNs: 15_000_000,
        result: "fresh",
        matched: true,
      },
    },
    ...overrides,
  };
}

const CACHED_CHILD = nativeRecord({
  seq: 2,
  tBeginNs: 90_000_000,
  tReturnedNs: 90_500_000,
  startSlot: {
    kind: "preparing",
    readyFresh: false,
    preparesReady: 3,
    readyGeneration: 3,
  },
  begin: "cached",
  ticket: null,
});

const diagnostics = (begins, cacheHits, lateCached, extra = {}) => ({
  begins,
  cacheHits,
  lateCached,
  quarantines: 0,
  deferredReleased: 0,
  deferredExpired: 0,
  deferredDropped: 0,
  staleReadyRetired: 0,
  prepareFailures: 0,
  driftAtQuery: 0,
  stamp0Missing: 0,
  ...extra,
});

function input(overrides = {}) {
  return {
    variantKey: "dev:dev-lantern.v1/base",
    phase: "measured",
    repeat: 0,
    d2aMode: "restricted",
    observation: observation(),
    nativeRecords: [nativeRecord(), CACHED_CHILD],
    a3: null,
    r1: r1Record({
      slot: "empty",
      cacheOccupied: false,
      cacheCleared: 1,
      sinceLastSeededMs: 1_500,
      previousReleaseWithinLimit: true,
      waitedMs: 3,
    }),
    r2: r2Record({ cacheOccupiedAtEnd: false, cleared: false }),
    counters: {
      before: diagnostics(10, 3, 3),
      atEnd: diagnostics(12, 4, 4),
      afterRelease: diagnostics(12, 4, 4, { deferredReleased: 1 }),
    },
    expectedContribution: {
      appendedSceneIds: ["dev-added"],
      pathAttachmentSceneIds: ["dev-b"],
    },
    ...overrides,
  };
}

const classify = (row) => classifyFollowUp(row, { context: "steady" });

test("R7: hook の消費者の観測から、分類器が F1〜F7 を判定できる記録を作る（成功の形）", () => {
  const row = k64GraphSampleRow(input());
  assert.equal(row.followUp.issuedVia, "product-hook");
  assert.equal(row.runnerKind, K64_RUNNER_KIND);
  assert.deepEqual(missingR7(row, "steady"), []);
  const result = classify(row);
  assert.equal(result.followUp, true, JSON.stringify(result.stages));
  assert.deepEqual(result.q, { q1: 17, q2: 14, q3: 45 });
  const { parent, child } = row.followUp;
  // 親: t_pub_p は親の fetch の返却（製品が hook に公開した時刻）、宣言は settle の呼出し。
  assert.equal(parent.tPub, 110.9);
  assert.equal(parent.declaration, "unused");
  assert.equal(parent.declaredAt, 110.85);
  assert.equal(parent.graphContinueAnswer, "cancelled");
  assert.equal(parent.generation, 1);
  assert.equal(parent.queryGeneration, 41);
  assert.deepEqual(parent.ticket, {
    settled: true,
    outcome: "available",
    reason: null,
    disposition: "unused",
    busyCause: null,
  });
  // 子: 契機の印と窓は製品の timing、到着は wrapper の層の時刻、commit は React。
  assert.equal(child.generation, 2);
  assert.equal(child.origin, "graph-ready");
  assert.equal(child.refreshTrigger, "graph-ready");
  assert.equal(child.graphWindowMs, 100);
  assert.equal(child.beginKind, "cached");
  assert.equal(child.beginAt, 118.5);
  assert.equal(child.tGraph, 139);
  assert.equal(child.irArrivedAt, 131);
  assert.equal(child.tFollow, 145);
  assert.equal(child.reactCommitAt, 146);
  assert.equal(child.publishCount, 1);
  assert.equal(child.expectedContribution, true);
  assert.equal(child.chronicleIndexUsable, true);
  assert.deepEqual(row.followUp.nativeBegins, ["pending", "cached"]);
  assert.deepEqual(row.followUp.counters, {
    before: { begins: 10, cacheHits: 3, lateCached: 3 },
    after: { begins: 12, cacheHits: 4, lateCached: 4 },
  });
  assert.equal(row.followUp.dPrimeCounters.deferredReleased, 1);
  assert.deepEqual(row.followUp.loading, { switched: false, ms: null });
  // q4（開示だけ）: Native の時計の受渡しから決着まで、子の begin。通知までは Native
  // の時刻が無いので測らない。
  assert.equal(row.followUp.q4.parent.handOverToSettledMs, 20);
  assert.equal(row.followUp.q4.child.beginMs, 0.5);
  assert.equal(row.followUp.q4.settledToNoticeMs, null);
  assert.equal(row.followUp.q4.noticeAfterParentPublishMs, 117 - 110.9);
  const q4 = summarizeQ4([row]);
  assert.equal(q4.parentHandOverToSettledMs.n, 1);
  assert.equal(q4.settledToNotice, "not-measured:no-native-notice-time");
});

test("R7: 通知と子が無い、index-ready の子、Cached でない子、R1 の未達", () => {
  const none = classify(
    k64GraphSampleRow(
      input({
        observation: observation({ child: null }),
        nativeRecords: [nativeRecord()],
        counters: {
          before: diagnostics(10, 3, 3),
          atEnd: diagnostics(11, 3, 3),
          afterRelease: diagnostics(11, 3, 3),
        },
      }),
    ),
  );
  assert.equal(none.x.X3, "no-notice");
  assert.equal(none.x.X6, "no-child");
  const indexReady = observation();
  indexReady.notices.push({ kind: "index-ready", at: 116 });
  const fromIndex = k64GraphSampleRow(input({ observation: indexReady }));
  assert.equal(fromIndex.followUp.child.origin, "index-ready");
  assert.match(
    classify(fromIndex)
      .stages.map((row) => row.detail)
      .join(),
    /origin:index-ready.*index-ready-between/u,
  );
  const pending = classify(
    k64GraphSampleRow(
      input({
        nativeRecords: [nativeRecord(), nativeRecord({ seq: 2 })],
      }),
    ),
  );
  assert.equal(pending.x.X4, "child-not-cached");
  const notQuiet = k64GraphSampleRow(
    input({
      r1: r1Record({
        slot: "empty",
        cacheOccupied: false,
        cacheCleared: 0,
        sinceLastSeededMs: 1_500,
        previousReleaseWithinLimit: false,
        waitedMs: 10_000,
      }),
    }),
  );
  assert.equal(notQuiet.followUp.r1.reachedQuiet, false);
  assert.equal(classify(notQuiet).x.X10, "reached-quiet-false");
  // R1 (1)〜(4) は記録が自分で観測した値から計算する。
  for (const [change, quiet] of [
    [{ slot: "deferred" }, false],
    [{ cacheOccupied: true }, false],
    [{ sinceLastSeededMs: 999 }, false],
    [{ sinceLastSeededMs: null }, true],
    [{ sinceLastSeededMs: 1_000 }, true],
  ])
    assert.equal(
      r1Record({
        slot: "empty",
        cacheOccupied: false,
        cacheCleared: 0,
        sinceLastSeededMs: 1_500,
        previousReleaseWithinLimit: true,
        waitedMs: 0,
        ...change,
      }).reachedQuiet,
      quiet,
      JSON.stringify(change),
    );
});

test("R7: 一覧の読込み中への切替え（(b-3)）、子の二段の公開（N32）、公開されない子（X6）", () => {
  const switched = observation();
  switched.commits.splice(2, 0, {
    at: 117.6,
    fetchSeq: null,
    loading: true,
    display: null,
  });
  const loading = k64GraphSampleRow(input({ observation: switched }));
  assert.equal(loading.followUp.loading.switched, true);
  assert.ok(Math.abs(loading.followUp.loading.ms - (146 - 117.6)) < 1e-9);
  assert.equal(classify(loading).loadingSwitched, true);
  const twice = observation();
  twice.commits.push({
    at: 150,
    fetchSeq: 2,
    loading: false,
    display: "child-with-more",
  });
  const twoStage = classify(k64GraphSampleRow(input({ observation: twice })));
  assert.ok(twoStage.violations.includes("N32:child-published-more-than-once"));
  const unresolved = observation({ child: { resolvedAt: null, result: null } });
  unresolved.commits.pop();
  const lost = classify(k64GraphSampleRow(input({ observation: unresolved })));
  // 戻らなかった子は初回 snapshot が分からないので記録の欠け（X10）。未表示に変わりない。
  assert.equal(lost.followUp, false);
  assert.match(lost.x.X10, /child\.chronicleIndexUsable/u);
});

test("R7: 子の合流の結果・IR の deadline・寄与・Chronicle の停止・親の ticket・Native の記録の数・quarantine", () => {
  const withChild = (child) => observation({ child });
  const late = classify(
    k64GraphSampleRow(
      input({
        observation: withChild({
          result: result({
            ...CHILD_RESULT,
            graphOutcome: "graph-late",
            graph: null,
          }),
        }),
      }),
    ),
  );
  assert.equal(late.x.X13, "graph-late");
  const slowIr = observation();
  slowIr.api.find(
    (row) => row.cmd === "related_scenes_continue" && row.calledAt === 125.2,
  ).resolvedAt = 140;
  assert.deepEqual(
    classify(k64GraphSampleRow(input({ observation: slowIr }))).ratification12,
    ["child-ir-deadline-beyond-d"],
  );
  const empty = classify(
    k64GraphSampleRow(
      input({
        expectedContribution: {
          appendedSceneIds: ["dev-other"],
          pathAttachmentSceneIds: [],
        },
      }),
    ),
  );
  assert.equal(empty.x.X5, "empty-contribution");
  // 期待寄与の材料が登録されていなければ寄与は確かめられない（X5、厳しい側）。
  assert.equal(
    classify(k64GraphSampleRow(input({ expectedContribution: null }))).x.X5,
    "empty-contribution",
  );
  const stopped = classify(
    k64GraphSampleRow(
      input({
        observation: withChild({
          result: result({
            ...CHILD_RESULT,
            initialSnapshot: { indexUsable: false, querySupported: true },
          }),
        }),
      }),
    ),
  );
  assert.equal(stopped.x.X5, "ir:index-unavailable");
  const unsettled = classify(
    k64GraphSampleRow(
      input({
        nativeRecords: [
          nativeRecord({
            ticket: {
              ...nativeRecord().ticket,
              settled: false,
              tSettledNs: null,
              outcome: null,
              disposition: null,
            },
          }),
          CACHED_CHILD,
        ],
      }),
    ),
  );
  assert.equal(unsettled.x.X1, "unsettled");
  const extra = classify(
    k64GraphSampleRow(
      input({
        nativeRecords: [nativeRecord(), CACHED_CHILD, CACHED_CHILD],
      }),
    ),
  );
  assert.equal(extra.x.X4, "child-not-cached");
  assert.match(
    extra.stages.map((row) => row.detail).join(),
    /begin-records:pending>cached>cached/u,
  );
  const quarantined = classify(
    k64GraphSampleRow(
      input({
        counters: {
          before: diagnostics(10, 3, 3),
          atEnd: diagnostics(12, 4, 4),
          afterRelease: diagnostics(12, 4, 4, { quarantines: 1 }),
        },
      }),
    ),
  );
  assert.equal(quarantined.x.X2, "quarantine");
  // 2 回目以降の通知は記録するだけ（F3）。
  const again = observation();
  again.notices.push({ kind: "graph-ready", at: 140 });
  assert.equal(
    classify(k64GraphSampleRow(input({ observation: again }))).followUp,
    true,
  );
});

test("R7: 親の表示に D の後の Graph が混ざれば記録に残す（N1）。seed の無い Graph の sample と親の無い観測は止める", () => {
  const mixed = observation({
    parent: {
      result: result({
        graphOutcome: "graph-ready",
        graph: {
          edgeCount: 1,
          graphOnlySceneId: null,
          pathAttachmentSceneIds: ["dev-b"],
        },
      }),
    },
  });
  mixed.api[2] = api("related_scenes_graph_continue", 100.5, 125, {
    status: "available",
  });
  const record = buildFollowUpRecord({
    ...input({ observation: mixed }),
  });
  assert.equal(record.parent.lateGraphInDisplay, true);
  assert.throws(
    () =>
      k64GraphSampleRow(
        input({
          observation: observation({ parent: { seed: null } }),
        }),
      ),
    /\[precheck\] R5/,
  );
  assert.throws(
    () =>
      k64GraphSampleRow(
        input({
          observation: observation({
            parent: { resolvedAt: null, result: null },
          }),
        }),
      ),
    /\[artifact\]/,
  );
});
