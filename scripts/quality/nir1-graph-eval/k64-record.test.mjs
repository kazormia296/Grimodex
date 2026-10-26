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
