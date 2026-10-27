// R7 の記録の producer（S1f）。renderer の hook の消費者の観測（合成）と Native の
// 記録・counter から、分類器（followup.mjs）が読む記録を作れることを、分類の結果で
// 確かめる。値はすべて合成（H5／RS-JOIN の形を真似た時刻）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSteadyStateCase } from "./availability.mjs";
import { devVariant } from "./constants.mjs";
import { classifyFollowUp, missingR7 } from "./followup.mjs";
import {
  K64_RUNNER_KIND,
  buildFollowUpRecord,
  k64GraphSampleRow,
  r1Record,
  summarizeQ4,
} from "./k64-record.mjs";
import {
  K64_CACHED_CHILD as CACHED_CHILD,
  K64_CHILD_RESULT as CHILD_RESULT,
  k64Api as api,
  k64Diagnostics as diagnostics,
  k64FetchResult as result,
  k64HookInput as input,
  k64NativeRecord as nativeRecord,
  k64Observation as observation,
  ratification5,
} from "./test-support.mjs";

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
  // DR-CP4-F-6: Scene の単位の照合は予告専用と記録に書く。
  assert.equal(child.contributionBasis, "scene-level-preview");
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

test("R7 → case の要約: hook の消費者の 30 件から K6/4 の表示の可用性と q1〜q4 の分布を出す", () => {
  const rows = Array.from({ length: 30 }, (_, repeat) =>
    k64GraphSampleRow(input({ repeat })),
  );
  const { entry, invalid } = summarizeSteadyStateCase({
    rows,
    variant: devVariant({
      key: "dev:dev-lantern.v1/base",
      expectedGraph: "available",
    }),
    fixedGraphMode: "restricted",
    candidate: ratification5(),
  });
  assert.deepEqual(invalid, []);
  assert.equal(entry.k64.followUp, 30);
  assert.equal(entry.k64.missed, 0);
  assert.equal(entry.k64.q1.n, 30);
  assert.equal(entry.k64.q4.parentHandOverToSettledMs.n, 30);
  assert.equal(entry.k64.q4.childBeginMs.n, 30);
  assert.equal(
    entry.k64.q4.settledToNotice,
    "not-measured:no-native-notice-time",
  );
});

test("R7（実機で見つけた誤り）: 親の IR が timeout でも、子の呼出しの前に graph-ready が来ていれば子は通知の取り直し（再試行の timer は消える）", () => {
  const timedOut = {
    resultKind: "raw",
    irStatus: "unavailable",
    irReason: "timeout",
    completion: { outcome: "timeout", deadlineExceeded: true },
    irSceneIds: [],
  };
  const notified = observation({ parent: { result: result(timedOut) } });
  const row = k64GraphSampleRow(input({ observation: notified }));
  assert.equal(row.followUp.child.origin, "graph-ready");
  assert.equal(row.followUp.parent.irRetryTimer, true);
  const classified = classify(row);
  // 親の IR が ready でないので成功にはならない（X11、F4 の timer の条件）。
  assert.equal(classified.followUp, false);
  assert.equal(classified.x.X11, "timeout");
  assert.ok(
    classified.stages.some((stage) => stage.detail === "ir-retry-timer"),
  );
  assert.ok(
    !classified.stages.some((stage) => stage.detail === "origin:ir-retry"),
  );
  // 通知より前に子が呼ばれていれば、子は IR の再試行。
  const retried = observation({ parent: { result: result(timedOut) } });
  retried.notices = [{ kind: "graph-ready", at: 119 }];
  assert.equal(
    k64GraphSampleRow(input({ observation: retried })).followUp.child.origin,
    "ir-retry",
  );
});

/** The probe's display key (cp4-k64-probe `displayKey`). */
const displayKey = (outcome, sceneIds, graph) =>
  JSON.stringify([outcome, sceneIds, graph]);

const caseOf = (rows) =>
  summarizeSteadyStateCase({
    rows,
    variant: devVariant({
      key: "dev:dev-lantern.v1/base",
      expectedGraph: "available",
    }),
    fixedGraphMode: "restricted",
    candidate: ratification5(),
  });

test("P2-3: 終わりの後の観測の窓で、子の世代の二度目の公開（hook が作り直した結果）が N32 になり、case は FAIL の違反を持つ。latency と読込み中の切替えは終わりまでの commit のまま", () => {
  const second = observation();
  // 子の最初の commit（146）の後、窓の中で hook が結果を作り直して公開した。
  second.commits.push(
    { at: 150, fetchSeq: null, loading: true, display: null },
    {
      at: 160,
      fetchSeq: -1,
      loading: false,
      display: displayKey("graph-ready", ["dev-a"], ["dev-added", []]),
    },
  );
  const row = k64GraphSampleRow(input({ observation: second }));
  const { child } = row.followUp;
  assert.equal(child.publishCount, 2);
  assert.equal(child.reactCommitAt, 146);
  assert.deepEqual(child.mixWindow, { reason: "settled", until: 241 });
  // 窓の中の読込み中は (b-3) の切替えに数えない（sample の終わりの後）。
  assert.deepEqual(row.followUp.loading, { switched: false, ms: null });
  const result = classify(row);
  assert.ok(result.violations.includes("N32:child-published-more-than-once"));
  assert.equal(result.followUp, false);
  assert.equal(result.q.q3, 45);
  const rows = Array.from({ length: 30 }, (_, repeat) =>
    k64GraphSampleRow(input({ repeat })),
  );
  rows[3] = k64GraphSampleRow(input({ repeat: 3, observation: second }));
  const { entry } = caseOf(rows);
  assert.ok(
    entry.k64.violations.some(
      (row) => row.code === "N32:child-published-more-than-once",
    ),
    JSON.stringify(entry.k64.violations),
  );
  // 窓が無かった前の probe（子の最初の commit で unmount）なら数えられない形。
  const cut = observation();
  assert.equal(
    k64GraphSampleRow(input({ observation: cut })).followUp.child.publishCount,
    1,
  );
});

test("P2-3: W_f の後に届いた子の Graph が窓の中で子の表示に混ざれば N29（子の答えは graph-late で Graph を持たない）", () => {
  const lateChild = {
    result: result({
      ...CHILD_RESULT,
      graphOutcome: "graph-late",
      graph: null,
      finalSceneIds: ["dev-a", "dev-b", "dev-c"],
    }),
  };
  const mixed = observation({ child: lateChild });
  mixed.api = mixed.api.map((row) =>
    row.cmd === "related_scenes_graph_continue" &&
    row.calledAt === 125.2 &&
    row.settle === null
      ? { ...row, resolvedAt: 300, status: "available" }
      : row,
  );
  // 窓の中: 遅れた Graph を足した表示（fetch の返した object でない）。
  mixed.commits.push({
    at: 301,
    fetchSeq: -1,
    loading: false,
    display: displayKey("graph-ready", ["dev-a"], ["dev-added", []]),
  });
  const row = k64GraphSampleRow(input({ observation: mixed }));
  assert.equal(row.followUp.child.lateGraphInDisplay, true);
  const classified = classify(row);
  assert.ok(
    classified.violations.includes("N29:late-graph-in-child-display"),
    JSON.stringify(classified.violations),
  );
  // 同じ seq の commit でも、子の答えに無い Graph を見せれば同じ。
  const patched = observation({ child: lateChild });
  patched.commits.push({
    at: 301,
    fetchSeq: 2,
    loading: false,
    display: displayKey("graph-ready", ["dev-a"], ["dev-added", []]),
  });
  assert.equal(
    k64GraphSampleRow(input({ observation: patched })).followUp.child
      .lateGraphInDisplay,
    true,
  );
  // Graph を見せない窓の commit は混入ではない。
  const plain = observation({ child: lateChild });
  plain.commits.push({
    at: 301,
    fetchSeq: 2,
    loading: false,
    display: displayKey("graph-late", ["dev-a"], null),
  });
  assert.equal(
    k64GraphSampleRow(input({ observation: plain })).followUp.child
      .lateGraphInDisplay,
    false,
  );
});

test("P2-3: 窓が harness の上限で切れた・窓の記録が無い子は公開の回数を観測しきれないので X10。子が返らなければ窓は要らない。窓の中の fetch は sample の数に入れない", () => {
  for (const mixWindow of [
    { reason: "harness-limit", until: 2_146.5 },
    undefined,
  ]) {
    const cut = observation();
    if (mixWindow === undefined) delete cut.mixWindow;
    else cut.mixWindow = mixWindow;
    const row = k64GraphSampleRow(input({ observation: cut }));
    assert.ok(missingR7(row, "steady").includes("child.mixWindow"));
    assert.match(classify(row).x.X10, /child\.mixWindow/u);
  }
  const pending = observation({ child: { resolvedAt: null, result: null } });
  pending.commits.pop();
  pending.mixWindow = { reason: "not-applied", until: 146.5 };
  assert.ok(
    !missingR7(
      k64GraphSampleRow(input({ observation: pending })),
      "steady",
    ).includes("child.mixWindow"),
  );
  const third = observation();
  third.fetches.push({
    ...third.fetches[1],
    seq: 3,
    queryGeneration: 44,
    calledAt: 170,
    resolvedAt: 200,
  });
  const row = k64GraphSampleRow(input({ observation: third }));
  assert.equal(row.sampleEnd.fetches, 2);
  assert.equal(row.sampleEnd.fetchesInMixWindow, 1);
});

test("レビュー P3: F2 は R4 の release の待ちの後の counter でも同じ差分を求める（厳しい側）。記録が無ければ X10", () => {
  const extra = k64GraphSampleRow(
    input({
      counters: {
        before: diagnostics(10, 3, 3),
        atEnd: diagnostics(12, 4, 4),
        afterRelease: diagnostics(13, 4, 5),
      },
    }),
  );
  const classified = classify(extra);
  assert.equal(classified.followUp, false);
  assert.ok(
    classified.stages.some(
      (stage) =>
        stage.detail ===
        "counters-after-release:begins=3,lateCached=2,cacheHits=1",
    ),
    JSON.stringify(classified.stages),
  );
  const unread = k64GraphSampleRow(
    input({
      counters: {
        before: diagnostics(10, 3, 3),
        atEnd: diagnostics(12, 4, 4),
      },
    }),
  );
  assert.ok(missingR7(unread, "steady").includes("countersAfterRelease"));
});

test("レビュー P3: Native の begin の記録の数が renderer の begin と合わなければ、どれが子の記録か分からないので X4（beginRecordsAligned を判定に使う）", () => {
  const row = k64GraphSampleRow(
    input({
      nativeRecords: [nativeRecord(), CACHED_CHILD, nativeRecord({ seq: 3 })],
    }),
  );
  assert.equal(row.followUp.beginRecordsAligned, false);
  assert.equal(row.followUp.child.beginKind, "unaligned");
  const classified = classify(row);
  assert.ok(
    classified.stages.some(
      (stage) =>
        stage.code === "X4" && stage.detail === "begin-records-unaligned",
    ),
    JSON.stringify(classified.stages),
  );
  assert.equal(
    classifyFollowUp(row, { context: "trace" }).stages.some(
      (stage) => stage.detail === "begin-records-unaligned",
    ),
    true,
  );
});
