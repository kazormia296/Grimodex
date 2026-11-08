// K6/6 受入れ（K6/6-P1〜P5、K6/6-N1〜N13）の合成記録の試験（非判定の dev の試作）。
//
// draftRef nir1-final-request-eval-proposal/6（改訂 3。未確認）の「受入れ」は、
// CP-4 の分類器が first-render の R-6（準備の句）・R-7（鮮度の印の句）と
// FR-1〜FR-8 の下位条件を、R1 の下の現実の形の記録で期待どおりに分けることを
// 求める。記録はすべて作り物で、凍結した G-case の材料は読まない。基の形は
// test-support.mjs の `k66Sample`（`startSlot.kind: empty`、`readyFresh: false`、
// stamp `stamp0-missing`、begin `["pending"]`）で、K6/5-P1 の記録
// （`readyFresh: true`、`fresh`。R1 の下では起きない）は使わない。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideCp4Availability,
  summarizeSteadyState,
} from "./availability.mjs";
import { GRAPH_EVAL_D_MS } from "./constants.mjs";
import { classifyFollowUp, missingR7, nextGraphArmOf } from "./followup.mjs";
import {
  followUpRecord,
  k64Sample,
  k66Run,
  k66Sample,
  summarizeK64,
} from "./test-support.mjs";

const NEXT = { preparesReady: 11 };
const run = (row, next = NEXT) =>
  classifyFollowUp(row, { context: "steady", next });

function counted(row, next = NEXT) {
  const result = run(row, next);
  assert.equal(
    result.firstRender,
    true,
    JSON.stringify(result.firstRenderFails),
  );
  assert.equal(result.display, "first-render");
  assert.deepEqual(result.violations, []);
  return result;
}

/** Not counted as a first render, and the sub-condition (prefix) is named. */
function notCounted(row, code, next = NEXT) {
  const result = run(row, next);
  assert.equal(result.firstRender, false, JSON.stringify(result));
  assert.equal(result.displayed, false);
  // 下位条件ごとに 1 例で、ほかの条件はすべて満たす（K6/6 受入れ）: 落ちた理由は
  // ちょうど 1 つで、期待の code（接頭辞）で始まる。
  assert.equal(
    result.firstRenderFails.length,
    1,
    `${code} alone in ${JSON.stringify(result.firstRenderFails)}`,
  );
  assert.ok(
    result.firstRenderFails[0].startsWith(code),
    `${code} in ${JSON.stringify(result.firstRenderFails)}`,
  );
  // F1 parent-joined keeps the reason in its detail (変える点 7).
  assert.match(result.x.F1, /^parent-joined:/u);
  return result;
}

const FOLLOW_UP_CHILD = () => k64Sample().followUp.child;

// ---- Positive ---------------------------------------------------------------

test("K6/6-P1: R1 の下の現実の形（slot empty、readyFresh false、begin [pending]、counter の差分 1、通知・子・IR の再試行なし）の親は、stamp が fresh でも stamp0-missing でも first-render の窓内で、子は出ない", () => {
  for (const arrivedAt of [100 + 11, 100 + 25, 100 + GRAPH_EVAL_D_MS])
    for (const freshnessStamp of [
      { result: "fresh", matched: true, attemptedAtNs: 95_000 },
      { result: "stamp0-missing", matched: null, attemptedAtNs: 95_000 },
    ]) {
      const row = k66Sample({ graph: { arrivedAt }, freshnessStamp });
      assert.equal(row.startSlot.readyFresh, false);
      assert.equal(row.startSlot.kind, "empty");
      const result = counted(row);
      assert.deepEqual(result.firstRenderFails, []);
      assert.equal(result.followUp, false);
      assert.deepEqual(result.displayedSceneIds, [
        "dev-a",
        "dev-b",
        "dev-added",
      ]);
    }
});

test("K6/6-P1: 間に hybrid arm の sample を挟んでも、同じ phase の次の Graph arm の sample との差が 1 なら数える", () => {
  const graph = (preparesReady, repeat) =>
    k66Sample({
      repeat,
      startSlot: { kind: "empty", readyFresh: false, preparesReady },
    });
  const hybrid = (repeat) => ({
    variantKey: "G-02/base",
    arm: "hybrid",
    phase: "measured",
    repeat,
    trigger: "user-operation",
    finalSceneIds: ["dev-a", "dev-b"],
  });
  const rows = [graph(10, 0), hybrid(0), graph(11, 1), hybrid(1), graph(12, 2)];
  const nexts = nextGraphArmOf(rows);
  assert.deepEqual(nexts.get(rows[0]), { preparesReady: 11 });
  assert.deepEqual(nexts.get(rows[2]), { preparesReady: 12 });
  assert.equal(nexts.get(rows[4]), null, "the phase's last Graph arm sample");
  assert.equal(nexts.has(rows[1]), false, "a hybrid arm row has no entry");
  for (const at of [0, 2, 4]) counted(rows[at], nexts.get(rows[at]));
});

test("nextGraphArmOf は variant と phase ごとに次の Graph arm の sample を引き、warm-up と measured、別の variant を混ぜない", () => {
  const row = (variantKey, phase, repeat, preparesReady) =>
    k66Sample({
      variantKey,
      phase,
      repeat,
      startSlot: { kind: "empty", readyFresh: false, preparesReady },
    });
  const rows = [
    row("G-01/v1", "warmup", 0, 1),
    row("G-01/v1", "measured", 0, 3),
    row("G-02/base", "warmup", 0, 20),
    row("G-01/v1", "measured", 1, 4),
    row("G-02/base", "measured", 0, 22),
  ];
  const nexts = nextGraphArmOf(rows);
  assert.equal(nexts.get(rows[0]), null);
  assert.deepEqual(nexts.get(rows[1]), { preparesReady: 4 });
  assert.equal(nexts.get(rows[3]), null);
  assert.equal(nexts.get(rows[2]), null);
  assert.equal(nexts.get(rows[4]), null);
});

test("K6/6-P3: follow-up の sample（begin [pending, cached]、F1〜F7 を満たす）は R-6 の (b) を当てずに follow-up の成功に数える", () => {
  const row = k64Sample();
  assert.deepEqual(row.followUp.nativeBegins, ["pending", "cached"]);
  const result = classifyFollowUp(row, { context: "steady" });
  assert.equal(result.followUp, true, JSON.stringify(result.x));
  assert.equal(result.firstRender, false);
  assert.deepEqual(result.firstRenderFails, []);
  assert.equal(result.display, "follow-up");
  // preparesStarted が 1 でなくても、follow-up には当てない。
  const other = classifyFollowUp(
    k64Sample(
      {},
      {
        dPrimeCounters: {
          ...followUpRecord().dPrimeCounters,
          preparesStarted: 3,
          preparesReady: 3,
        },
      },
    ),
    { context: "steady" },
  );
  assert.equal(other.followUp, true);
});

test("K6/6-P4: phase の最後の Graph arm の sample は (c) を当てられず、(b) の counter の差分で判定する（他の条件を満たせば数える）", () => {
  counted(k66Sample(), null);
  // (b) の counter が合わなければ、(c) を当てなくても数えない。
  notCounted(
    k66Sample({}, { dPrimeCounters: { preparesStarted: 2 } }),
    "b:prepares-started-2",
    null,
  );
});

test("K6/6-P5: trace の record（dPrimeCounters が従来の 7 key で preparesStarted・preparesReady を持たない）は X10 の記録の欠けにならない。定常状態では欠けになる", () => {
  const sevenKeys = Object.fromEntries(
    Object.entries(followUpRecord().dPrimeCounters).filter(
      ([key]) => key !== "preparesStarted" && key !== "preparesReady",
    ),
  );
  assert.equal(Object.keys(sevenKeys).length, 7);
  const trace = k64Sample({}, { dPrimeCounters: sevenKeys });
  assert.deepEqual(missingR7(trace, "trace"), []);
  assert.deepEqual(
    missingR7(trace, "steady"),
    ["dPrimeCounters"],
    "the steady state needs the two new keys",
  );
  const result = classifyFollowUp(trace, { context: "trace" });
  assert.equal(Object.hasOwn(result.x, "X10"), false, JSON.stringify(result.x));
});

// ---- Negative（どれも数えない。分母から除かない） --------------------------------

test("K6/6-N1a: R1 の reachedQuiet が false なら first-render に数えず、X10", () => {
  const result = notCounted(
    k66Sample({}, { r1: { reachedQuiet: false } }),
    "a:reached-quiet-false",
  );
  assert.equal(result.x.X10, "reached-quiet-false");
});

test("K6/6-N1b: R1 の 4 項目の計算し直しが自己申告と合わなければ数えず、X10", () => {
  const result = notCounted(
    k66Sample({}, { r1: { slotEmpty: false, reachedQuiet: true } }),
    "a:r1-self-report-disagrees",
  );
  assert.match(result.x.X10, /^r1-self-report-disagrees:slot/u);
});

test("K6/6-N2a: 親の begin の記録が [pending] でなければ数えない", () => {
  notCounted(
    k66Sample({}, { nativeBegins: ["pending", "pending"] }),
    "b:begin-records-",
  );
  notCounted(k66Sample({}, { nativeBegins: [] }), "b:begin-records-");
});

test("K6/6-N2b: startSlot.kind が empty でなければ数えない", () => {
  notCounted(
    k66Sample({
      startSlot: { kind: "ready", readyFresh: true, preparesReady: 10 },
    }),
    "b:start-slot-ready",
  );
});

test("K6/6-N2c〜N2g: preparesStarted・preparesReady・deferredReleased（0 も 2 も）・staleReadyRetired の差分が合わなければ数えない", () => {
  for (const [dPrimeCounters, code] of [
    [{ preparesStarted: 2 }, "b:prepares-started-2"],
    [{ preparesStarted: 0 }, "b:prepares-started-0"],
    [{ preparesReady: 2 }, "b:prepares-ready-2"],
    [{ preparesReady: 0 }, "b:prepares-ready-0"],
    [{ deferredReleased: 0 }, "b:deferred-released-0"],
    [{ deferredReleased: 2 }, "b:deferred-released-2"],
    [{ staleReadyRetired: 1 }, "b:stale-ready-retired-1"],
  ])
    notCounted(k66Sample({}, { dPrimeCounters }), code);
});

test("K6/6-N2h: 次の同じ phase の Graph arm の sample との preparesReady の差が 2（間に hybrid arm を挟む）なら数えず、理由を開示する。差が 0 でも、次が記録なしでも数えない", () => {
  notCounted(k66Sample(), "c:next-prepares-ready-diff-2", {
    preparesReady: 12,
  });
  notCounted(k66Sample(), "c:next-prepares-ready-diff-0", {
    preparesReady: 10,
  });
  notCounted(k66Sample(), "c:prepares-ready-unrecorded", {
    preparesReady: undefined,
  });
  // 次の sample を渡さない（nextGraphArmOf を通さない）呼出しは数えずに止める。
  assert.throws(
    () => classifyFollowUp(k66Sample(), { context: "steady" }),
    /\[precheck\].*\(c\)/u,
  );
});

test("K6/6-N3a: stamp が unavailable の親は数えない（分母に残る）", () => {
  notCounted(
    k66Sample({
      freshnessStamp: {
        result: "unavailable",
        matched: null,
        attemptedAtNs: 95_000,
      },
    }),
    "FR3:stamp-unavailable",
  );
});

test("K6/6-N3b: stamp の記録が null の親は数えない", () => {
  notCounted(k66Sample({ freshnessStamp: null }), "FR3:stamp-missing");
});

test("K6/6-N3c: stamp0-missing で親の ticket が available でない記録は数えない（合流した親では起きない空の検査。記録の誤りを見つけるために置く）", () => {
  notCounted(
    k66Sample(
      {},
      {
        parent: {
          ticket: {
            settled: true,
            outcome: "unavailable",
            reason: "invalidated",
            disposition: null,
            busyCause: null,
          },
        },
      },
    ),
    "FR3:ticket-not-available",
  );
});

test("K6/6-N4: 窓内に合流した親の stamp が stale なら [artifact]（製品は stale で query を投げず、合流させない）", () => {
  assert.throws(
    () =>
      run(
        k66Sample({
          freshnessStamp: {
            result: "stale",
            matched: false,
            attemptedAtNs: 95_000,
          },
        }),
      ),
    /\[artifact\].*stale/u,
  );
});

test("K6/6-N5a〜N5d: owner の counter の差分（after と afterRelease の両方で begins 1・lateCached 0・cacheHits 0）を block ごと・key ごとに単独で破ると数えず、R2 の終わりの cache が空でなくても数えない", () => {
  // 基の記録は after・afterRelease とも { begins: 11, cacheHits: 3, lateCached: 3 }
  // （差分 1・0・0）。block と key を 1 つずつ破る。
  const base = k66Sample().followUp;
  const breaks = { begins: 12, cacheHits: 4, lateCached: 4 };
  const label = {
    after: "FR4:counters-after-",
    afterRelease: "FR4:counters-after-release-",
  };
  const delta = { begins: 1, cacheHits: 0, lateCached: 0 };
  for (const block of ["after", "afterRelease"])
    for (const key of ["begins", "lateCached", "cacheHits"]) {
      const record = block === "after" ? base.counters.after : base.countersAfterRelease;
      const broken = { ...record, [key]: breaks[key] };
      const overrides =
        block === "after"
          ? { counters: { after: broken } }
          : { countersAfterRelease: broken };
      const expected = { ...delta, [key]: delta[key] + 1 };
      notCounted(
        k66Sample({}, overrides),
        `${label[block]}begins=${expected.begins},lateCached=${expected.lateCached},cacheHits=${expected.cacheHits}`,
      );
    }
  notCounted(
    k66Sample({}, { r2: { cacheEmptyAtEnd: false } }),
    "FR4:cache-left-at-end",
  );
  // afterRelease の記録そのものが無いのも数えない（厳しい側）。
  notCounted(
    k66Sample({}, { countersAfterRelease: undefined }),
    "FR4:counters-after-release-missing",
  );
});

test("K6/6-N6a: 窓内に合流した親の後に graph-ready の通知があれば数えず、開示する", () => {
  notCounted(
    k66Sample({}, { notices: [{ kind: "graph-ready", at: 130 }] }),
    "FR6:graph-ready-notice",
  );
});

test("K6/6-N6b: 子（origin が index-ready の例）があれば数えず、開示する", () => {
  notCounted(
    k66Sample({}, { child: { ...FOLLOW_UP_CHILD(), origin: "index-ready" } }),
    "FR6:child-index-ready",
  );
});

test("K6/6-N6c: 親の IR の再試行の timer が動いていれば数えず、開示する", () => {
  notCounted(
    k66Sample({}, { parent: { irRetryTimer: true } }),
    "FR6:ir-retry-timer",
  );
});

test("K6/6-N7a〜N7e: 親の寄与の記録（FR-7）が無い、基準が scene-level-preview、unresolvedEdges が 1 以上、edge が 0 件、期待寄与の材料からの寄与が無い親は数えない", () => {
  notCounted(
    k66Sample({}, { parent: { contribution: null } }),
    "FR7:no-contribution-record",
  );
  const contribution = (overrides) => ({
    expectedContribution: true,
    contributionBasis: "material-revision",
    materialRevision: {
      matched: ["graph-only:x"],
      unresolvedEdges: 0,
      observed: [],
    },
    ...overrides,
  });
  notCounted(
    k66Sample(
      {},
      {
        parent: {
          contribution: contribution({
            contributionBasis: "scene-level-preview",
          }),
        },
      },
    ),
    "FR7:basis-scene-level-preview",
  );
  notCounted(
    k66Sample(
      {},
      {
        parent: {
          contribution: contribution({
            materialRevision: { matched: [], unresolvedEdges: 1, observed: [] },
          }),
        },
      },
    ),
    "FR7:unresolved-edges-1",
  );
  notCounted(k66Sample({ graph: { edgeCount: 0 } }), "FR7:no-edge");
  notCounted(
    k66Sample(
      {},
      {
        parent: { contribution: contribution({ expectedContribution: false }) },
      },
    ),
    "FR7:no-expected-contribution",
  );
});

test("K6/6-N10a・N10b: 窓内に合流した親で driftAtQuery か prepareFailures の差分が 1 なら [artifact]", () => {
  for (const key of ["driftAtQuery", "prepareFailures"])
    assert.throws(
      () => run(k66Sample({}, { dPrimeCounters: { [key]: 1 } })),
      /\[artifact\].*FR-8/u,
      key,
    );
});

test("K6/6-N11a: FR-1 出所が Cached の窓内の親は数えない（K6/4-N39）", () => {
  notCounted(k66Sample({ graph: { source: "cache" } }), "FR1:source-cache");
});

test("K6/6-N11b: FR-1 joined なのに revalidation が null なら classifyJoin が止める（[artifact]）", () => {
  assert.throws(
    () => run(k66Sample({ graph: { revalidation: null } })),
    /\[artifact\].*revalidation/u,
  );
});

test("K6/6-N12a: FR-5 宣言が used でなければ数えない（stamp が fresh なら FR-5 だけを欠く。stamp0-missing では FR-3 ② の宣言の検査も同時に落ちる）", () => {
  notCounted(
    k66Sample(
      {
        freshnessStamp: {
          result: "fresh",
          matched: true,
          attemptedAtNs: 95_000,
        },
      },
      { parent: { declaration: "unused" } },
    ),
    "FR5:declaration-unused",
  );
  const both = run(k66Sample({}, { parent: { declaration: "unused" } }));
  assert.equal(both.firstRender, false);
  assert.deepEqual(both.firstRenderFails, [
    "FR3:declaration-not-used",
    "FR5:declaration-unused",
  ]);
});

test("K6/6-N12b: FR-5 publishCount が 2 なら数えず、K6/4-N1 の FAIL", () => {
  const result = notCounted(
    k66Sample({}, { parent: { publishCount: 2 } }),
    "FR5:publish-count-2",
  );
  assert.ok(result.violations.includes("N1:parent-published-more-than-once"));
});

test("K6/6-N12c: FR-5 親の窓が 40 ms でなければ [precheck]", () => {
  assert.throws(
    () => run(k66Sample({}, { parent: { graphWindowMs: 100 } })),
    /\[precheck\].*Graph window/u,
  );
  assert.throws(
    () => run(k66Sample({}, { parent: { graphWindowMs: null } })),
    /\[precheck\]/u,
  );
});

// ---- 集計と品質 --------------------------------------------------------------

test("K6/6 の集計: R1 の下の現実の形の Gold（全 variant の全 measured が first-render）は欠落 0 で、開示に K6/2 の字義の件数と stamp の内訳を載せる", () => {
  const summary = summarizeK64(k66Run());
  assert.equal(summary.status, "valid", JSON.stringify(summary.invalid));
  assert.equal(summary.regime, "k64");
  assert.equal(summary.k64.display.missed, 0);
  assert.equal(summary.k64.display.firstRender, summary.pool.n);
  assert.equal(summary.k64.display.followUp, 0);
  for (const entry of summary.cases.filter((row) => row.inPool)) {
    // K6/2 の字義では R1 の下では 1 件も数えられない（開示）。
    assert.equal(entry.inWindow, 0);
    assert.equal(entry.notReadyAtStart, entry.n);
    assert.equal(entry.stampResults["stamp0-missing"], entry.n);
    assert.equal(entry.k64.firstRenderCandidates, entry.n);
    assert.equal(entry.k64.firstRenderNotCounted, 0);
    assert.equal(entry.k64.contributedNotCounted, 0);
    // /6 の読みでは全件が first-render なので窓外 0（K6/2 の字義の率は別名）。
    assert.equal(entry.k64.firstRenderOutOfWindow, 0);
    assert.equal(entry.k64.firstRenderOutOfWindowRate, 0);
    assert.equal(entry.outOfWindowRate, 1);
  }
  assert.equal(summary.k64.display.firstRenderOutOfWindowRate, 0);
  assert.equal(summary.k64.firstRenderOutOfWindowRate, 0);
  assert.equal(summary.k64.k62OutOfWindowRate, 1);
  assert.equal(summary.pool.outOfWindowRate, 1);
  const disclosure = decideCp4Availability({
    steadyState: summary,
    traces: [],
  }).disclose;
  assert.equal(disclosure.firstRenderOutOfWindowRate, 0);
  assert.equal(disclosure.k62OutOfWindowRate, 1);
});

test("K6/6 の開示: 数えられなかった親を (a)(b)(c)・FR の下位条件ごとに数える（1 つの親が複数に載りうる）", () => {
  const summary = summarizeK64(
    k66Run((_variant, repeat) =>
      repeat === 1
        ? [
            {},
            {
              dPrimeCounters: { preparesStarted: 2 },
              parent: { declaration: "unused" },
            },
          ]
        : repeat === 4
          ? [
              {
                freshnessStamp: {
                  result: "unavailable",
                  matched: null,
                  attemptedAtNs: 95_000,
                },
              },
              {},
            ]
          : [{}, {}],
    ),
  );
  const entry = summary.cases.find((row) => row.variantKey === "G-02/base");
  assert.equal(entry.k64.firstRenderNotCounted, 2);
  assert.equal(entry.k64.firstRenderNotCountedBy.b, 1);
  assert.equal(entry.k64.firstRenderNotCountedBy.FR5, 1);
  assert.equal(entry.k64.firstRenderNotCountedBy.FR3, 2);
  assert.equal(entry.k64.contributedNotCounted, 1);
  // 数えられなかった親は分母に残り、欠落に数える（分母から除かない）。
  assert.equal(entry.k64.n, entry.n);
  assert.equal(entry.k64.missed, 2);
  // first-render の窓外率は /6 の件数から求める（一部だけ数えられる合成）。
  assert.equal(entry.k64.firstRenderOutOfWindow, 2);
  assert.equal(entry.k64.firstRenderOutOfWindowRate, 2 / entry.n);
  const pooled = summary.cases.filter((row) => row.inPool);
  const outside = pooled.reduce(
    (sum, row) => sum + row.k64.firstRenderOutOfWindow,
    0,
  );
  assert.ok(outside >= 2 && outside < summary.pool.n);
  assert.equal(summary.k64.display.firstRenderOutOfWindow, outside);
  assert.equal(summary.k64.firstRenderOutOfWindowRate, outside / summary.pool.n);
  assert.equal(summary.k64.k62OutOfWindowRate, 1);
});

test("K6/6-N8: 窓内に合流した stamp0-missing の親だけを分母から外した samples は拒否する（(iii′)）", () => {
  const rows = k66Run().filter(
    (row) =>
      !(
        row.variantKey === "G-02/base" &&
        row.arm === "graph" &&
        row.phase === "measured" &&
        row.repeat < 5
      ),
  );
  assert.throws(() => summarizeK64(rows), /predeclared AB\/BA schedule/u);
});

test("K6/6 R-6 (c) の開示: 背景の再準備が次の sample の前に走った親は数えられず、欠落になる（残余 (3)）", () => {
  // G-02/base の measured repeat 10 以降の Graph arm の sample の preparesReady を
  // 1 つ飛ばす（repeat 9 とその次の sample の間に再準備が 1 回余分にあった形）。
  const summary = summarizeK64(
    k66Run().map((row) =>
      row.variantKey === "G-02/base" &&
      row.arm === "graph" &&
      row.phase === "measured" &&
      row.repeat >= 10
        ? {
            ...row,
            startSlot: {
              ...row.startSlot,
              preparesReady: row.startSlot.preparesReady + 1,
            },
          }
        : row,
    ),
  );
  const entry = summary.cases.find((row) => row.variantKey === "G-02/base");
  assert.equal(entry.k64.firstRenderNotCounted, 1);
  assert.equal(entry.k64.firstRenderNotCountedBy.c, 1);
  assert.equal(entry.k64.missed, 1);
});

test("summarizeSteadyState は K6/6 の R1 の下の記録でも、K6/2 の時代（candidate なし）の要約を変えない", () => {
  const summary = summarizeSteadyState({
    samples: k66Run(),
    fixedGraphMode: "restricted",
    plan: { kind: "frozen" },
  });
  assert.equal(summary.regime, "k62");
  assert.equal(
    summary.pool.inWindow,
    0,
    "K6/2's literal reading never counts under R1",
  );
});
