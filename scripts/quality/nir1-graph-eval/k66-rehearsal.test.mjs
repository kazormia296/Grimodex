// K6/6 の dev の予行の評価（k66-rehearsal.mjs）。非判定。R1 の下の現実の形の
// 合成の samples（test-support.mjs `k66Sample`）で、下限・止める条件・FR-7 の
// 取得を、予行の結果の型で確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  K66_REHEARSAL_NOT_JUDGED,
  assessK66Rehearsal,
  assessK66RehearsalQuality,
} from "./k66-rehearsal.mjs";
import { followUpRecord, k64Sample, k66Sample } from "./test-support.mjs";

/** `count` measured Graph arm rows of one variant, preparesReady 10, 11, … */
function rows(
  count,
  mutate = () => [{}, {}],
  variantKey = "dev:dev-shape-g02.v1/base",
) {
  return Array.from({ length: count }, (_, repeat) => {
    const [overrides = {}, followUp = {}] = mutate(repeat);
    return k66Sample(
      {
        variantKey,
        phase: "measured",
        repeat,
        startSlot: {
          kind: "empty",
          readyFresh: false,
          preparesReady: 10 + repeat,
        },
        ...overrides,
      },
      followUp,
    );
  });
}

test("予行: 窓内に合流した親が 30 件あり、FR-7 の記録が全件にあり、落ちた親が無ければ ok（非判定）", () => {
  const result = assessK66Rehearsal(rows(30), {
    fixture: "dev-shape-g02.v1.json",
    fixtureVersion: "dev-shape-g02/1",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.joinedInWindow, 30);
  assert.equal(result.fr7Recorded, 30);
  assert.equal(result.dropped, 0);
  assert.equal(result.notJudged, K66_REHEARSAL_NOT_JUDGED);
  assert.equal(result.fixture, "dev-shape-g02.v1.json");
});

test("予行: 窓内に合流した親が 30 件に満たなければ『未実施』で、凍結に進まない", () => {
  const result = assessK66Rehearsal(rows(29));
  assert.equal(result.status, "not-run");
  assert.match(result.next, /fix the dev fixture and retake/u);
  // 合流しても窓の外（D の後）の親は数えない。
  const late = assessK66Rehearsal(
    rows(40, (repeat) =>
      repeat < 20 ? [{ graph: { arrivedAt: 100 + 40 + 20 } }, {}] : [{}, {}],
    ),
  );
  assert.equal(late.joinedInWindow, 20);
});

test("予行: 窓内に合流した親のうち 1/30 を超えて落ちたら止める。1/30 までは止めない。落ちた理由を下位条件ごとに数える", () => {
  // 30 件中 1 件落ちる（1/30）: 止めない。
  const one = assessK66Rehearsal(
    rows(30, (repeat) =>
      repeat === 3
        ? [{}, { dPrimeCounters: { preparesStarted: 2 } }]
        : [{}, {}],
    ),
  );
  assert.equal(one.dropped, 1);
  assert.equal(one.status, "ok");
  // 31 件中 2 件（2/31 > 1/30）: 止める。
  const two = assessK66Rehearsal(
    rows(31, (repeat) =>
      repeat === 3 || repeat === 9
        ? [{}, { dPrimeCounters: { preparesStarted: 2 } }]
        : [{}, {}],
    ),
  );
  assert.equal(two.dropped, 2);
  assert.equal(two.status, "stop");
  assert.deepEqual(two.droppedByCondition, { b: 2 });
  assert.deepEqual(
    two.droppedParents.map((row) => [row.repeat, row.reasons]),
    [
      [3, ["b:prepares-started-2"]],
      [9, ["b:prepares-started-2"]],
    ],
  );
});

test("予行: FR-7 の記録が窓内に合流した親の全件に無ければ、/6 では判定せず /7 で再確認する（FR-7 を外す・緩めることはしない）", () => {
  const result = assessK66Rehearsal(
    rows(30, (repeat) =>
      repeat === 5 ? [{}, { parent: { contribution: undefined } }] : [{}, {}],
    ),
  );
  assert.equal(result.status, "fr7-record-missing");
  assert.equal(result.fr7Recorded, 29);
  assert.match(result.next, /\/7/u);
  assert.match(result.next, /neither dropped nor loosened/u);
});

test("予行: 記録の誤り（FR-8。stale で合流した親）は artifact として止める", () => {
  const result = assessK66Rehearsal(
    rows(30, (repeat) =>
      repeat === 2
        ? [
            {
              freshnessStamp: {
                result: "stale",
                matched: false,
                attemptedAtNs: 95_000,
              },
            },
            {},
          ]
        : [{}, {}],
    ),
  );
  assert.equal(result.status, "artifact");
  assert.match(result.artifacts[0].message, /FR-8/u);
});

test("予行の品質の予告: /6 の regime で、Graph が寄与したのに first-render に数えられない親は FAIL（非判定）", () => {
  const variant = {
    key: "dev:dev-shape-g08.v1/graph-recovered",
    expectedGraph: "available",
  };
  const graph = (mutate) =>
    rows(30, mutate, variant.key).map((row) => ({ ...row, arm: "graph" }));
  const pairs = (rowsOfGraph) => [
    ...rowsOfGraph,
    ...rowsOfGraph.map((row) => ({
      ...row,
      arm: "hybrid",
      finalSceneIds: ["dev-a", "dev-b"],
    })),
  ];
  const ok = assessK66RehearsalQuality([
    { variant, samples: pairs(graph(() => [{}, {}])) },
  ]);
  assert.equal(ok.fail, 0);
  assert.equal(ok.variants[0].status, "measurable");
  assert.equal(ok.notJudged, K66_REHEARSAL_NOT_JUDGED);
  // Graph が寄与したが (a)〜(c)・FR の下位条件で first-render に数えられない親。
  const bad = assessK66RehearsalQuality([
    {
      variant,
      samples: pairs(
        graph((repeat) =>
          repeat === 4
            ? [{}, { dPrimeCounters: { preparesStarted: 2 } }]
            : [{}, {}],
        ),
      ),
    },
  ]);
  assert.equal(bad.fail, 1);
  assert.equal(
    bad.variants[0].reason,
    "graph-contributed-parent-not-counted-as-first-render",
  );
  // 30 組でなければ invalid（その他に数える）。
  const invalid = assessK66RehearsalQuality([
    { variant, samples: pairs(graph(() => [{}, {}])).slice(1) },
  ]);
  assert.equal(invalid.other, 1);
});

test("予行の品質の予告: G-08/chronicle-index-unusable は品質判定 v2 の D2・D3 に揃える（index-ready の子は子から外して D3 で見る）", () => {
  const variant = {
    key: "dev:dev-shape-g08.v1/chronicle-index-unusable",
    expectedGraph: "unavailable",
  };
  const pair = ["dev-a", "dev-b"];
  const run = (childOverrides = {}, extra = {}) => {
    const graph = Array.from({ length: 30 }, (_, repeat) => ({
      ...k64Sample(
        {
          variantKey: variant.key,
          arm: "graph",
          phase: "measured",
          repeat,
          finalSceneIds: pair,
          snapshot: { usable: true, reason: null, chronicleIndexUsable: false },
          irOutcome: "index-unavailable",
          graph: { outcome: "graph-unavailable", reason: "index-state" },
        },
        {
          child: {
            ...followUpRecord().child,
            origin: "index-ready",
            refreshTrigger: null,
            chronicleIndexUsable: true,
            outcome: "graph-ready",
            edgeCount: 1,
            publishCount: 1,
            finalSceneIds: pair,
            materialRevision: {
              unresolvedEdges: 0,
              observed: [
                {
                  kind: "path-attachment",
                  sceneId: "dev-c",
                  pairs: ["rev|edge"],
                },
              ],
            },
            ...childOverrides,
          },
        },
      ),
    }));
    const hybrid = graph.map((row) => ({
      ...row,
      arm: "hybrid",
      finalSceneIds: pair,
    }));
    return assessK66RehearsalQuality([
      { variant, samples: [...graph, ...hybrid], ...extra },
    ]);
  };
  const typedRevisions = {
    rev: { id: "rev", relationIds: ["edge"], decision: "approved" },
  };
  // v1 の読みでは「子が Graph を出した」で FAIL だった形が、D3 の対象になり、setup の記録があれば pass（fallback-measured）。
  const ok = run({}, { typedRevisions });
  assert.equal(ok.variants[0].status, "fallback-measured");
  assert.deepEqual(ok.variants[0].d3.problems, []);
  assert.equal(ok.variants[0].d3.eligible, 30);
  assert.equal(ok.variants[0].d3.graphShown, 30);
  // setup の記録が無ければ (d) は引けず hold（予行は FAIL にしない）。
  assert.equal(run().variants[0].status, "hold");
  // 禁止 Scene への path の寄与は fail。
  const forbidden = run({}, { typedRevisions, forbiddenSceneIds: ["dev-c"] });
  assert.equal(forbidden.variants[0].status, "fail");
  assert.equal(
    forbidden.variants[0].reason,
    "a2-index-ready-requery-forbidden",
  );
  // 観測した Revision が最新でなければ fail。
  const old = run(
    {},
    {
      typedRevisions: {
        ...typedRevisions,
        later: { id: "later", relationIds: ["edge"], decision: "none" },
      },
    },
  );
  assert.equal(old.variants[0].status, "fail");
  // 6 条件の 1 つを欠く index-ready の子は子のまま（fail closed）: FAIL。
  const kept = run({ chronicleIndexUsable: false }, { typedRevisions });
  assert.equal(kept.variants[0].status, "fail");
  assert.equal(
    kept.variants[0].reason,
    "graph-shown-for-a-variant-expected-unavailable",
  );
  // 他の variant（G-08/chronicle-index-unusable 以外）は D3 を当てない。
  const other = assessK66RehearsalQuality([
    {
      variant: {
        ...variant,
        key: "dev:dev-shape-g08.v1/both-indexes-unusable",
      },
      samples: [
        ...Array.from({ length: 30 }, (_, repeat) =>
          k64Sample(
            {
              variantKey: "dev:dev-shape-g08.v1/both-indexes-unusable",
              arm: "graph",
              phase: "measured",
              repeat,
              finalSceneIds: pair,
              graph: { outcome: "graph-unavailable", reason: "index-state" },
            },
            { child: null },
          ),
        ),
        ...Array.from({ length: 30 }, (_, repeat) => ({
          ...k64Sample(
            {
              variantKey: "dev:dev-shape-g08.v1/both-indexes-unusable",
              arm: "hybrid",
              phase: "measured",
              repeat,
              finalSceneIds: pair,
            },
            { child: null },
          ),
        })),
      ],
    },
  ]);
  assert.equal(other.variants[0].d3, undefined);
});
