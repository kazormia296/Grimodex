// K6/4 受入れ（K6/4-P1〜P3、K6/4-N1〜N40）の合成記録の試験。
// draftRef nir1-final-request-eval-proposal/4（SHA-256 d205b35f…23c3）の
// 「受入れ（可用性）」は、CP-4 の分類器が Negative のそれぞれを期待どおりに
// 分けることを、観測の前に合成の記録で示すことを求める（K6/4:222、209）。
// 記録はすべて作り物で、凍結した G-case の材料は読まない。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideCp4Availability,
  evaluateDiagnosticCondition,
  summarizeSteadyState,
  summarizeTrace,
} from "./availability.mjs";
import {
  GRAPH_EVAL_D_MS,
  K64_FREEZE,
  K64_R1_R4_WAIT_CEILING_MS,
  K64_T_LATE_MS,
  K64_T_SHOW_MS,
  K64_W_F_MS,
  rejectOverrides,
} from "./constants.mjs";
import {
  assessCandidateRegime,
  classifyFollowUp,
  followUpFailureCategory,
} from "./followup.mjs";
import {
  k64Sample,
  late,
  ratification5,
  sample,
  scheduleRows,
  k64Run,
  summarizeK64,
  unavailableRecord,
} from "./test-support.mjs";

const steady = (row) => classifyFollowUp(row, { context: "steady" });
const inTrace = (row) => classifyFollowUp(row, { context: "trace" });

/** Not displayed, and the X code (with its detail when given) is recorded. */
function missedWith(result, code, detail) {
  assert.equal(result.displayed, false, JSON.stringify(result));
  assert.equal(result.followUp, false);
  assert.ok(
    Object.hasOwn(result.x, code),
    `${code} in ${JSON.stringify(result.x)}`,
  );
  if (detail !== undefined) assert.equal(result.x[code], detail);
}

test("K6/4 の定数は契約の値を 1 か所に持つ（判断 2〜4、技術点 2、批准 7）", () => {
  assert.equal(K64_W_F_MS, 100);
  assert.equal(K64_T_LATE_MS, 100);
  assert.equal(K64_T_SHOW_MS, 2_000);
  assert.equal(K64_R1_R4_WAIT_CEILING_MS, 10_000);
  assert.equal(GRAPH_EVAL_D_MS, 10.84);
  assert.equal(
    K64_FREEZE.sha256,
    "d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3",
  );
  assert.equal(
    K64_FREEZE.path,
    "docs/plans/nir1-final-request-eval-proposal-4-draft.md",
  );
  for (const key of ["wf", "W_f", "tLate", "t-show", "tShowMs", "waitMs"])
    assert.throws(
      () => rejectOverrides({ [key]: 150 }, []),
      /\[precheck\].*frozen/,
      key,
    );
});

// ---- Positive ---------------------------------------------------------

test("K6/4-P1: F1〜F7 をすべて満たす query は follow-up の成功で、子の表示を測る", () => {
  const result = steady(k64Sample());
  assert.equal(result.firstRender, false);
  assert.equal(result.followUp, true);
  assert.equal(result.displayed, true);
  assert.equal(result.display, "follow-up");
  assert.deepEqual(result.x, {});
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.ratification12, []);
  assert.deepEqual(result.q, { q1: 17, q2: 14, q3: 45 });
  assert.deepEqual(result.displayedSceneIds, [
    "dev-a",
    "dev-b",
    "dev-c",
    "dev-added",
  ]);
  // 境界は「以下」: q1 = T_late、q2 = W_f、q3 = T_show ちょうどは成功。
  const edge = steady(
    k64Sample(
      {},
      {
        notices: [{ kind: "graph-ready", at: 100 + K64_T_LATE_MS }],
        child: {
          beginAt: 201,
          tRawReady: 210,
          irArrivedAt: 215,
          tGraph: 210 + K64_W_F_MS,
          tFollow: 100 + K64_T_SHOW_MS,
          reactCommitAt: 100 + K64_T_SHOW_MS,
        },
      },
    ),
  );
  assert.equal(edge.followUp, true, JSON.stringify(edge.x));
});

test("K6/4-P2: 親が D の窓内に worker の結果を受けたら first-render の窓内で、子は出ない", () => {
  const firstRender = sample({ followUp: undefined });
  const result = steady({
    ...firstRender,
    followUp: {
      ...k64Sample().followUp,
      child: null,
      notices: [],
      parent: { ...k64Sample().followUp.parent, declaration: "used" },
    },
  });
  assert.equal(result.firstRender, true);
  assert.equal(result.displayed, true);
  assert.equal(result.display, "first-render");
  assert.deepEqual(result.displayedSceneIds, ["dev-a", "dev-b", "dev-added"]);
});

// ---- Negative（どれも成功に数えず、分母から除かない） -------------------------

test("K6/4-N1: 親の表示に D の後の Graph が混ざったら FAIL（遅れた結果を混ぜない）", () => {
  const result = steady(
    k64Sample({}, { parent: { lateGraphInDisplay: true } }),
  );
  assert.ok(result.violations.includes("N1:late-graph-in-parent-display"));
  assert.equal(result.followUp, false);
  const twice = steady(k64Sample({}, { parent: { publishCount: 2 } }));
  assert.ok(twice.violations.includes("N1:parent-published-more-than-once"));
});

test("K6/4-N2: harness が出した query の cache の hit は X7", () => {
  missedWith(
    steady(k64Sample({}, { child: { origin: "harness" } })),
    "X7",
    "origin:harness",
  );
});

test("K6/4-N3: 親の ticket が stale で、前の sample の ticket が cache を埋めた並びは X10 か F3 で検出する", () => {
  const stale = {
    settled: true,
    outcome: "unavailable",
    reason: "stale",
    disposition: "unused",
    busyCause: null,
  };
  // counter は begins 2、late_cached 1、cache_hits 1 のまま（前の sample の ticket が埋めた）。
  const quiet = steady(
    k64Sample(
      {},
      {
        parent: { ticket: stale },
        r1: {
          slotEmpty: true,
          cacheEmpty: true,
          sinceLastSeededMs: 1_500,
          previousReleaseWithinLimit: false,
          reachedQuiet: false,
        },
      },
    ),
  );
  missedWith(quiet, "X10", "reached-quiet-false");
  assert.equal(quiet.x.X1, "stale");
  const early = steady(
    k64Sample(
      {},
      {
        parent: { ticket: stale },
        notices: [{ kind: "graph-ready", at: 105 }],
        child: { beginAt: 106 },
      },
    ),
  );
  missedWith(early, "X3", "before-publish");
});

test("K6/4-N4: 子の合流が graph-late（W_f の後）は X13", () => {
  missedWith(
    steady(k64Sample({}, { child: { outcome: "graph-late", tGraph: 240 } })),
    "X13",
    "graph-late",
  );
});

test("K6/4-N5: 子の合流が graph-unavailable:invalidated（requalification、SeedChanged）は X5", () => {
  missedWith(
    steady(
      k64Sample(
        {},
        {
          child: {
            outcome: "graph-unavailable",
            reason: "invalidated",
            requalification: "invalidated",
            tGraph: null,
          },
        },
      ),
    ),
    "X5",
    "join:invalidated",
  );
});

test("K6/4-N6: 子の IR が timeout か unavailable は X5", () => {
  for (const irOutcome of ["timeout", "ir-unavailable"])
    missedWith(
      steady(k64Sample({}, { child: { irOutcome, irArrivedAt: null } })),
      "X5",
      `ir:${irOutcome}`,
    );
});

test("K6/4-N7: 最初の通知が T_late を超えたら X3", () => {
  missedWith(
    steady(
      k64Sample(
        {},
        {
          notices: [{ kind: "graph-ready", at: 100 + K64_T_LATE_MS + 0.001 }],
          child: { beginAt: 201 },
        },
      ),
    ),
    "X3",
    "late",
  );
});

test("K6/4-N8: 通知が来なければ X3", () => {
  missedWith(
    steady(k64Sample({}, { notices: [], child: null })),
    "X3",
    "no-notice",
  );
});

test("K6/4-N9: 子が Cached でなければ X4", () => {
  missedWith(
    steady(
      k64Sample(
        {},
        {
          child: { beginKind: "pending" },
          nativeBegins: ["pending", "pending"],
        },
      ),
    ),
    "X4",
  );
});

test("K6/4-N10: TTL の切れ、edge の epoch、quarantine、別の begin（D-final を含む）の後の子は X2", () => {
  for (const loss of [
    "ttl-expired",
    "edge-epoch-advanced",
    "quarantined",
    "other-begin:d-final",
  ])
    missedWith(
      steady(
        k64Sample({}, { cacheLoss: [loss], child: { beginKind: "pending" } }),
      ),
      "X2",
      loss,
    );
});

test("K6/4-N11: index-ready、編集、場面の切替え、IR の再試行による子は X7", () => {
  for (const origin of ["index-ready", "edit", "scene-switch", "ir-retry"])
    missedWith(
      steady(k64Sample({}, { child: { origin } })),
      "X7",
      `origin:${origin}`,
    );
  // 親と子の間の index-ready も F4 を満たさない。
  missedWith(
    steady(
      k64Sample(
        {},
        {
          notices: [
            { kind: "graph-ready", at: 117 },
            { kind: "index-ready", at: 118 },
          ],
        },
      ),
    ),
    "X7",
    "index-ready-between",
  );
});

test("K6/4-N12: 子の R か IR が親と違えば X9", () => {
  missedWith(steady(k64Sample({}, { child: { irSceneIds: ["dev-z"] } })), "X9");
  missedWith(
    steady(k64Sample({}, { child: { rSceneIds: ["dev-b", "dev-a"] } })),
    "X9",
  );
  // 比べるのは親の IR が ready のときだけ（親の IR が timeout なら X11 で、X9 は付けない）。
  const timeout = steady(
    k64Sample({ irOutcome: "timeout" }, { child: { irSceneIds: ["dev-z"] } }),
  );
  assert.ok(!Object.hasOwn(timeout.x, "X9"));
  assert.ok(Object.hasOwn(timeout.x, "X11"));
});

test("K6/4-N15: R7 の記録が欠けた query は X10", () => {
  const row = k64Sample();
  delete row.followUp.child.reactCommitAt;
  missedWith(steady(row), "X10");
  const counters = k64Sample({}, { counters: null });
  missedWith(steady(counters), "X10");
  const missing = k64Sample();
  delete missing.followUp;
  missedWith(steady(missing), "X10");
});

test("K6/4-N19: 親の ticket が stale で cache に入らなければ X1", () => {
  missedWith(
    steady(
      k64Sample(
        {},
        {
          parent: {
            ticket: {
              settled: true,
              outcome: "unavailable",
              reason: "stale",
              disposition: "unused",
              busyCause: null,
            },
          },
          notices: [],
          child: null,
          counters: {
            before: { begins: 10, cacheHits: 3, lateCached: 3 },
            after: { begins: 11, cacheHits: 3, lateCached: 3 },
          },
          nativeBegins: ["pending"],
        },
      ),
    ),
    "X1",
    "stale",
  );
});

test("K6/4-N20: 子が公開されず世代が変わったら X6", () => {
  missedWith(
    steady(
      k64Sample(
        {},
        {
          child: {
            completion: "invalidated",
            publishCount: 0,
            currentAtDisplay: false,
            tFollow: null,
            reactCommitAt: null,
          },
        },
      ),
    ),
    "X6",
  );
  missedWith(
    steady(k64Sample({}, { child: { currentAtDisplay: false } })),
    "X6",
    "generation-changed",
  );
});

test("K6/4-N22: 親の合流が graph-unavailable:warming／stale／busy で refresh した子は X12", () => {
  for (const reason of ["warming", "stale", "busy"])
    missedWith(
      steady(
        k64Sample(
          {
            ...late(reason, reason === "busy" ? { busyCause: "in-use" } : {}),
            finalSceneIds: ["dev-a", "dev-b", "dev-c"],
          },
          { parent: { ticket: null } },
        ),
      ),
      "X12",
      `graph-unavailable:${reason}`,
    );
});

test("K6/4-N23: late_cached の差分が 2 以上、または begin の記録が 3 件以上は X4", () => {
  missedWith(
    steady(
      k64Sample(
        {},
        {
          counters: {
            before: { begins: 10, cacheHits: 3, lateCached: 3 },
            after: { begins: 12, cacheHits: 4, lateCached: 5 },
          },
        },
      ),
    ),
    "X4",
    "counters:begins=2,lateCached=2,cacheHits=1",
  );
  missedWith(
    steady(
      k64Sample(
        {},
        {
          counters: {
            before: { begins: 10, cacheHits: 3, lateCached: 3 },
            after: { begins: 13, cacheHits: 4, lateCached: 4 },
          },
          nativeBegins: ["pending", "pending", "cached"],
        },
      ),
    ),
    "X4",
  );
  // R2: sample の終わりに cache が残っていたら X4。
  missedWith(
    steady(k64Sample({}, { r2: { cacheEmptyAtEnd: false } })),
    "X4",
    "cache-left-at-end",
  );
});

test("K6/4-N24: reachedQuiet: false の sample は X10（分母から除かない）", () => {
  const row = k64Sample(
    {},
    {
      r1: {
        slotEmpty: false,
        cacheEmpty: true,
        sinceLastSeededMs: 400,
        previousReleaseWithinLimit: true,
        reachedQuiet: false,
      },
    },
  );
  missedWith(steady(row), "X10", "reached-quiet-false");
  // (b) では R1 と R2 を当てない。
  assert.equal(inTrace(row).followUp, true);
});

test("K6/4-N25: IR の timeout の再試行による子は X7", () => {
  missedWith(
    steady(k64Sample({}, { parent: { irRetryTimer: true } })),
    "X7",
    "ir-retry-timer",
  );
});

test("K6/4-N26: 子の Graph の edge が 0 件か期待寄与が無ければ X5", () => {
  missedWith(
    steady(k64Sample({}, { child: { edgeCount: 0 } })),
    "X5",
    "empty-contribution",
  );
  missedWith(
    steady(k64Sample({}, { child: { expectedContribution: false } })),
    "X5",
    "empty-contribution",
  );
});

test("K6/4-N27: (q3) が T_show を超えたら X8", () => {
  missedWith(
    steady(
      k64Sample(
        {},
        { child: { tFollow: 100 + K64_T_SHOW_MS + 0.5, reactCommitAt: 2101 } },
      ),
    ),
    "X8",
  );
});

test("K6/4-N28: 親の IR が timeout の sample は X11", () => {
  missedWith(steady(k64Sample({ irOutcome: "timeout" })), "X11", "timeout");
});

test("K6/4-N29: W_f の後に届いた子の Graph が子の表示に混ざったら FAIL", () => {
  const mixed = steady(k64Sample({}, { child: { lateGraphInDisplay: true } }));
  assert.ok(mixed.violations.includes("N29:late-graph-in-child-display"));
  // graph-ready と言いながら W_f + 許容幅より後に届いた Graph も同じ。
  const beyond = steady(
    k64Sample({}, { child: { tGraph: 125 + K64_W_F_MS + 1 } }),
  );
  assert.ok(beyond.violations.includes("N29:child-joined-after-w-f"));
  assert.equal(beyond.followUp, false);
  // 許容幅の内は FAIL にしないが、成功にも数えない（開示する）。
  const within = steady(
    k64Sample({}, { child: { tGraph: 125 + K64_W_F_MS + 0.005 } }),
  );
  assert.deepEqual(within.violations, []);
  missedWith(within, "X13", "joined-late-within-tolerance");
});

test("K6/4-N30: 合流の窓の値が W_f と違う、子の IR の deadline が D より長い、W_f が親に当たった候補は批准 12 の違反", () => {
  const childWindow = steady(
    k64Sample({}, { child: { graphWindowMs: 10.840000000596048 } }),
  );
  assert.ok(childWindow.ratification12.includes("child-window-not-w-f"));
  assert.equal(childWindow.followUp, false);
  const parentWf = steady(k64Sample({}, { parent: { graphWindowMs: 100 } }));
  assert.ok(parentWf.ratification12.includes("parent-window-not-d"));
  const irDeadline = steady(
    k64Sample({}, { child: { irArrivedAt: 125 + GRAPH_EVAL_D_MS + 1 } }),
  );
  assert.ok(irDeadline.ratification12.includes("child-ir-deadline-beyond-d"));
  const other = steady(
    k64Sample(
      {},
      {
        child: {
          origin: "index-ready",
          refreshTrigger: null,
          graphWindowMs: 100,
        },
      },
    ),
  );
  assert.ok(other.ratification12.includes("w-f-on-another-trigger"));
});

test("K6/4-N32: 子の合流が 2 回以上公開したら FAIL", () => {
  const twice = steady(k64Sample({}, { child: { publishCount: 2 } }));
  assert.ok(twice.violations.includes("N32:child-published-more-than-once"));
  assert.equal(twice.followUp, false);
});

test("K6/4-N35: t_pub_p より前の通知は F3 の通知に数えない（X3）", () => {
  missedWith(
    steady(
      k64Sample(
        {},
        {
          notices: [
            { kind: "graph-ready", at: 109 },
            { kind: "graph-ready", at: 117 },
          ],
        },
      ),
    ),
    "X3",
    "before-publish",
  );
  // t_pub_p の後の 2 回目以降の通知は、それだけでは失敗にしない。
  assert.equal(
    steady(
      k64Sample(
        {},
        {
          notices: [
            { kind: "graph-ready", at: 117 },
            { kind: "graph-ready", at: 160 },
          ],
        },
      ),
    ).followUp,
    true,
  );
});

test("K6/4-N36: 子の query の Scene か seed が親と違えば X7", () => {
  missedWith(
    steady(k64Sample({}, { child: { seed: "entity-other" } })),
    "X7",
    "scene-or-seed-differs",
  );
  missedWith(
    steady(k64Sample({}, { child: { sceneId: "scene-x" } })),
    "X7",
    "scene-or-seed-differs",
  );
});

test("K6/4-N37: 親の ticket が registration-unavailable で cache に入らなければ X1", () => {
  missedWith(
    steady(
      k64Sample(
        {},
        {
          parent: {
            ticket: {
              settled: true,
              outcome: "unavailable",
              reason: "registration-unavailable",
              disposition: "unused",
              busyCause: null,
            },
          },
        },
      ),
    ),
    "X1",
    "registration-unavailable",
  );
});

test("K6/4-N38: 親の ticket が busy か warming で cache に入らなければ X1", () => {
  for (const [reason, busyCause] of [
    ["busy", "worker-capacity"],
    ["warming", null],
  ])
    missedWith(
      steady(
        k64Sample(
          {},
          {
            parent: {
              ticket: {
                settled: true,
                outcome: "unavailable",
                reason,
                disposition: "unused",
                busyCause,
              },
            },
          },
        ),
      ),
      "X1",
      reason,
    );
});

test("K6/4-N39: 親が Cached で D の窓内に合流した sample は first-render の窓内に数えない", () => {
  const cached = sample({
    startSlot: { kind: "empty", readyFresh: false },
    graph: { source: "cache" },
    followUp: { ...k64Sample().followUp, child: null, notices: [] },
  });
  const result = steady(cached);
  assert.equal(result.firstRender, false);
  assert.equal(result.displayed, false);
  assert.ok(Object.hasOwn(result.x, "F1"));
});

test("D-3: R1 は 4 つの項目から計算し直し、自己申告の reachedQuiet と食い違えば X10", () => {
  const r1 = (overrides) => ({
    slotEmpty: true,
    cacheEmpty: true,
    sinceLastSeededMs: 1_500,
    previousReleaseWithinLimit: true,
    reachedQuiet: true,
    ...overrides,
  });
  assert.equal(steady(k64Sample({}, { r1: r1({}) })).displayed, true);
  // 前の seed つきの sample が無い（最初の sample）ときは (3) を満たす。
  assert.equal(
    steady(k64Sample({}, { r1: r1({ sinceLastSeededMs: null }) })).displayed,
    true,
  );
  for (const [overrides, item] of [
    [{ slotEmpty: false }, "slot"],
    [{ cacheEmpty: false }, "cache"],
    [{ sinceLastSeededMs: 5 }, "interval"],
    [{ sinceLastSeededMs: 999 }, "interval"],
    [{ previousReleaseWithinLimit: false }, "release"],
  ])
    missedWith(
      steady(k64Sample({}, { r1: r1(overrides) })),
      "X10",
      `r1-self-report-disagrees:${item}`,
    );
  // 境界: 1 s ちょうどは「以上」で満たす。
  assert.equal(
    steady(k64Sample({}, { r1: r1({ sinceLastSeededMs: 1_000 }) })).displayed,
    true,
  );
});

test("D-5: (b) でも親が Cached で D の窓内に合流した query は表示に数えない（K6/4:165）", () => {
  const cached = k64Sample(
    {
      graph: {
        outcome: "graph-ready",
        source: "cache",
        joined: true,
        arrivedAt: 105,
        revalidation: "passed",
        edgeCount: 2,
      },
    },
    { child: null, notices: [] },
  );
  const result = inTrace(cached);
  assert.equal(result.firstRender, false);
  assert.equal(result.displayed, false);
  // worker 由来なら (b) の first-render（K6/2 の規則 2、stamp は問わない）。
  const worker = k64Sample(
    {
      graph: {
        outcome: "graph-ready",
        source: "worker",
        joined: true,
        arrivedAt: 105,
        revalidation: "passed",
        edgeCount: 2,
      },
    },
    { child: null, notices: [] },
  );
  assert.equal(inTrace(worker).firstRender, true);
  const trace = traceK64(
    k64Trace("browsing", 200, (at) =>
      at === 0
        ? [
            {
              graph: {
                outcome: "graph-ready",
                source: "cache",
                joined: true,
                arrivedAt: 105,
                revalidation: "passed",
                edgeCount: 2,
              },
            },
            { child: null, notices: [] },
          ]
        : [{}, {}],
    ),
  );
  assert.equal(trace.displayed, 199);
  assert.equal(trace.firstRenderInWindow, 0);
});

test("D-4: 子の初回 snapshot の chronicleIndexUsable が false なら子の Chronicle の停止として失効率に数える", () => {
  const result = inTrace(
    k64Sample({}, { child: { chronicleIndexUsable: false } }),
  );
  assert.equal(result.displayed, false);
  assert.ok(
    result.stages.some(
      (row) => row.code === "X5" && row.detail === "ir:index-unavailable",
    ),
  );
  const trace = traceK64(
    k64Trace("editing", 200, (at) =>
      at === 2 ? [{}, { child: { chronicleIndexUsable: false } }] : [{}, {}],
    ),
  );
  assert.equal(trace.lapse["i-chronicle-stop"], 1);
  // 記録に field が無い子は記録の不備（X10）。
  const record = k64Sample().followUp;
  delete record.child.chronicleIndexUsable;
  missedWith(inTrace(k64Sample({ followUp: record })), "X10");
});

test("D-7／D-9: t_pub_p と同時刻の通知は X3、定常状態の F2 は cache_hits 1、(b) の F2 は最初の begin が pending", () => {
  // (a) 境界: 親の公開と同時刻の通知は「公開の後」でない（DR-CP4-K64-4）。
  missedWith(
    steady(k64Sample({}, { notices: [{ kind: "graph-ready", at: 110.84 }] })),
    "X3",
    "before-publish",
  );
  // (b) cache_hits が 1 でなければ X4（begins と late_cached は合っている）。
  missedWith(
    steady(
      k64Sample(
        {},
        {
          counters: {
            before: { begins: 10, cacheHits: 3, lateCached: 3 },
            after: { begins: 12, cacheHits: 5, lateCached: 4 },
          },
        },
      ),
    ),
    "X4",
    "counters:begins=2,lateCached=1,cacheHits=2",
  );
  // D-9: (b) の最初の begin の記録が pending でなければ X4。
  missedWith(
    inTrace(k64Sample({}, { nativeBegins: ["cached", "cached"] })),
    "X4",
    "begin-records:cached>cached",
  );
  // (c) (b) の trace で開始時の B が使えない query は、follow-up が成功しても表示に数えない。
  const trace = traceK64(
    k64Trace("editing", 200, (at) =>
      at === 3
        ? [{ snapshot: { usable: false, reason: "sealed" } }, {}]
        : [{}, {}],
    ),
  );
  assert.equal(trace.U, 199);
  assert.equal(trace.displayed, 199);
});

test("D-8: IR の timeoutRate は親の IR の outcome だけで求め、子の IR の timeout は入れない（K6/4:167）", () => {
  const summary = summarizeK64(
    k64Run((variant, repeat) => {
      if (variant.key === "G-02/base" && repeat === 1)
        return [{ irOutcome: "timeout" }, {}];
      if (variant.key === "G-02/base" && repeat === 2)
        return [{}, { child: { irOutcome: "timeout" } }];
      return [{}, {}];
    }),
  );
  assert.equal(summary.k64.irTimeout.timeouts, 1);
  assert.equal(summary.k64.irTimeout.n, summary.k64.display.n);
});

test("D-11: 記録の欠けた（X10）sample でも遅れた結果の混入は違反として残す", () => {
  const record = k64Sample().followUp;
  delete record.counters;
  record.child.lateGraphInDisplay = true;
  record.child.publishCount = 2;
  const result = inTrace(k64Sample({ followUp: record }));
  assert.ok(Object.hasOwn(result.x, "X10"));
  assert.deepEqual(result.violations, [
    "N29:late-graph-in-child-display",
    "N32:child-published-more-than-once",
  ]);
  const parentRecord = k64Sample().followUp;
  delete parentRecord.notices;
  parentRecord.parent.lateGraphInDisplay = true;
  assert.deepEqual(inTrace(k64Sample({ followUp: parentRecord })).violations, [
    "N1:late-graph-in-parent-display",
  ]);
});

test("K6/4-N40: 子の世代の契機の印が無いか graph-ready でなければ X7", () => {
  for (const refreshTrigger of [null, "index-ready"])
    missedWith(
      steady(k64Sample({}, { child: { refreshTrigger } })),
      "X7",
      `trigger-mark:${refreshTrigger}`,
    );
  // 親の次の世代でない子も F4 を満たさない。
  missedWith(
    steady(k64Sample({}, { child: { generation: 3 } })),
    "X7",
    "not-next-generation",
  );
});

test("F4: 子の begin は t_notice の後（通知より前に始まった子は X7）", () => {
  missedWith(
    steady(k64Sample({}, { child: { beginAt: 116 } })),
    "X7",
    "child-before-notice",
  );
});

test("F1: graph-late でも宣言が unused でなければ follow-up にしない", () => {
  missedWith(
    steady(k64Sample({}, { parent: { declaration: "used" } })),
    "F1",
    "declaration:used",
  );
});

// ---- 定常状態の pool（K6/4-N13、N14、N16、N18、N21、N31、P3） ---------------

/**
 * The full frozen AB/BA schedule with K6/4 graph rows. `mutate(variant,
 * repeat)` returns [sample overrides, followUp overrides] for a measured row
 * of a variant expected available.
 */

const failNotice = [{}, { notices: [], child: null }];

test("K6/4-P3: pool の欠落率が 1% 以下でどの case にも表示があれば HOLD にせず、first-render の窓外率と内訳と q を開示する", () => {
  // 2 件の欠落 / 270（floor(0.01×270)=2）は内側。
  const two = k64Run((variant, repeat) =>
    repeat === 0 && ["G-02/base", "G-04/base"].includes(variant.key)
      ? failNotice
      : [{}, {}],
  );
  const summary = summarizeK64(two);
  assert.equal(summary.status, "valid", summary.invalid.join());
  assert.equal(summary.regime, "k64");
  assert.deepEqual(
    {
      n: summary.k64.display.n,
      displayed: summary.k64.display.displayed,
      missed: summary.k64.display.missed,
      allowedMisses: summary.k64.display.allowedMisses,
      exceeds: summary.k64.display.exceeds,
    },
    { n: 270, displayed: 268, missed: 2, allowedMisses: 2, exceeds: false },
  );
  assert.equal(summary.k64.display.followUp, 268);
  assert.equal(summary.k64.display.firstRender, 0);
  // N18: first-render の窓外率は K6/2 の規則のまま書く（D′ では全件が窓外）。
  assert.equal(summary.pool.outOfWindowRate, 1);
  assert.equal(summary.k64.firstRenderOutOfWindowRate, 1);
  assert.equal(summary.k64.x.X3, 2);
  assert.equal(summary.k64.q.q1.n, 268);
  assert.deepEqual(summary.k64.holdCases, []);
  assert.deepEqual(summary.k64.violations, []);
  assert.equal(
    decideCp4Availability({ steadyState: summary, traces: [] }).reason,
    "traces-not-measured",
  );
  const three = k64Run((variant, repeat) =>
    repeat === 0 &&
    ["G-02/base", "G-04/base", "G-05/base"].includes(variant.key)
      ? failNotice
      : [{}, {}],
  );
  const exceeding = summarizeK64(three);
  assert.equal(exceeding.k64.display.exceeds, true);
  const decision = decideCp4Availability({
    steadyState: exceeding,
    traces: [],
  });
  assert.equal(decision.verdict, "HOLD");
  assert.equal(decision.reason, "display-miss-rate-exceeds");
});

test("K6/4-N14: 表示された sample が 1 件もない case と pool が 0 件は HOLD", () => {
  const none = k64Run((variant) =>
    variant.key === "G-07/base" ? failNotice : [{}, {}],
  );
  const summary = summarizeK64(none);
  assert.deepEqual(summary.k64.holdCases, ["G-07/base"]);
  const decision = decideCp4Availability({ steadyState: summary, traces: [] });
  assert.equal(decision.verdict, "HOLD");
  assert.equal(decision.reason, "case-without-displayed-sample");
  // pool が 0 件（dev plan の unavailable だけ）も HOLD。
  const devKey = "dev:dev-g08.v1/unusable";
  const dev = scheduleRows([{ key: devKey, expectedGraph: "unavailable" }]).map(
    (row) =>
      row.arm === "graph" ? { ...row, followUp: unavailableRecord() } : row,
  );
  const empty = summarizeSteadyState({
    samples: dev,
    fixedGraphMode: "restricted",
    plan: {
      kind: "dev",
      variants: [{ key: devKey, expectedGraph: "unavailable" }],
    },
    candidate: ratification5(),
  });
  assert.equal(empty.k64.display.n, 0);
  assert.equal(empty.k64.poolEmpty, true);
});

test("K6/4-N16: 低い層の API の continue だけで判定した記録は無効", () => {
  const rows = k64Run((variant, repeat) =>
    variant.key === "G-02/base" && repeat === 3
      ? [{}, { issuedVia: "low-level-continue" }]
      : [{}, {}],
  );
  const summary = summarizeK64(rows);
  assert.equal(summary.status, "invalid");
  assert.match(summary.invalid.join(), /N16/);
});

test("K6/4-N1／N29／N32: 遅れた結果の混入は pool の判定と別に FAIL", () => {
  const rows = k64Run((variant, repeat) =>
    variant.key === "G-05/base" && repeat === 1
      ? [{}, { child: { publishCount: 2 } }]
      : [{}, {}],
  );
  const summary = summarizeK64(rows);
  assert.equal(summary.k64.violations.length, 1);
  assert.equal(
    summary.k64.violations[0].code,
    "N32:child-published-more-than-once",
  );
  assert.equal(
    decideCp4Availability({ steadyState: summary, traces: [] }).verdict,
    "FAIL",
  );
});

test("K6/4-N31: 批准 5 の (a)〜(c) のどれかを欠く候補には緩和を当てず K6/2 の文のまま（D′ では HOLD）", () => {
  for (const [label, evidence] of [
    ["no-evidence", null],
    [
      "no-dprime",
      ratification5({
        dPrime: { commit: ratification5().dPrime.commit, ancestor: false },
      }),
    ],
    [
      "no-hook",
      ratification5({
        rsJoinHook: {
          evidence: "candidate-test",
          testFile: ratification5().rsJoinHook.testFile,
          passed: false,
        },
      }),
    ],
    [
      "no-wf",
      ratification5({
        wfWindow: { commit: ratification5().wfWindow.commit, ancestor: false },
      }),
    ],
  ]) {
    const regime = assessCandidateRegime(evidence);
    assert.equal(regime.regime, "k62", label);
    assert.ok(regime.missing.length > 0, label);
    const summary = summarizeK64(k64Run(), evidence);
    assert.equal(summary.regime, "k62", label);
    const decision = decideCp4Availability({
      steadyState: summary,
      traces: [],
    });
    assert.equal(decision.verdict, "HOLD", label);
    assert.equal(
      decision.reason,
      "steady-state-out-of-window-rate-exceeds",
      label,
    );
  }
  // D-1: 手で書いた「hook の commit を祖先に持つ」は自己申告で、緩和を当てない
  // （git から集める経路は admission.test.mjs の D-1）。
  assert.deepEqual(
    assessCandidateRegime(
      ratification5({
        rsJoinHook: {
          evidence: "ancestor",
          commit: "c7b091dadabac6cc098a932052cf817493205204",
          ancestor: true,
        },
      }),
    ),
    { regime: "k62", missing: ["ratification5-not-collected"] },
  );
  // (b-3): graph-ready の取り直しで読込み中に替わった sample がある候補も (b) を欠く。
  const loading = summarizeK64(
    k64Run((variant, repeat) =>
      variant.key === "G-06/base" && repeat === 2
        ? [{}, { loading: { switched: true, ms: 435 } }]
        : [{}, {}],
    ),
  );
  assert.equal(loading.regime, "k62");
  assert.match(loading.k64NotApplied.join(), /b-3/);
  // N30: 批准 12 の違反が 1 件でもあれば、受領書全体に K6/4 の緩和を当てない。
  const window = summarizeK64(
    k64Run((variant, repeat) =>
      variant.key === "G-06/base" && repeat === 2
        ? [{}, { child: { graphWindowMs: 10.840000000596048 } }]
        : [{}, {}],
    ),
  );
  assert.equal(window.regime, "k62");
  assert.match(window.k64NotApplied.join(), /child-window-not-w-f/);
});

// ---- (b) の trace（「変える点」15。K6/4-N33、N34） ----------------------------

/** A K6/4 trace of `n` queries; `mutate(at)` returns [sample, followUp] overrides. */
function k64Trace(kind, n, mutate = () => [{}, {}]) {
  return {
    kind,
    queries: Array.from({ length: n }, (_, at) => {
      const [overrides = {}, followUp = {}] = mutate(at);
      return k64Sample(
        {
          queryId: `q${at}`,
          recordRead: { startedAtNs: at * 1e6 + 1, finishedAtNs: at * 1e6 + 2 },
          freshnessStamp: {
            result: "stale",
            matched: false,
            attemptedAtNs: at * 1e6 + 5,
          },
          ...overrides,
        },
        followUp,
      );
    }),
  };
}

const traceK64 = (value, candidate = ratification5()) =>
  summarizeTrace({ trace: value, fixedGraphMode: "restricted", candidate });

const staleTicket = {
  settled: true,
  outcome: "unavailable",
  reason: "stale",
  disposition: "unused",
  busyCause: null,
};

test("K6/4-N33: D′ の構造上の graph-late（開始時の slot が empty）を (b) の鮮度に数えない", () => {
  // 全 query が D′ の graph-late で、follow-up が成功すれば窓外は 0。
  const shown = traceK64(k64Trace("browsing", 200));
  assert.equal(shown.status, "valid", shown.invalid?.join());
  assert.equal(shown.regime, "k64");
  assert.deepEqual(
    [shown.Q, shown.U, shown.displayed, shown.outOfWindow],
    [200, 200, 200, 0],
  );
  assert.equal(shown.firstRenderInWindow, 0);
  // follow-up が T_late を超えて失敗した graph-late は「その他」で、鮮度ではない。
  const lateNotice = traceK64(
    k64Trace("browsing", 200, () => [
      {},
      { notices: [{ kind: "graph-ready", at: 250 }], child: { beginAt: 251 } },
    ]),
  );
  assert.equal(lateNotice.outOfWindowExceeds, true);
  assert.deepEqual(lateNotice.categories, {
    lapse: 0,
    other: 200,
    freshness: 0,
  });
  assert.equal(lateNotice.mainReason, "other");
  assert.ok(
    !Object.keys(lateNotice.reasons).some((name) =>
      name.startsWith("graph-late"),
    ),
  );
  // 要約の (3) の連鎖は起きない: 条件は成立せず row-not-used。
  const steadyInside = summarizeK64(k64Run());
  assert.equal(
    evaluateDiagnosticCondition({
      kind: "ii",
      steadyState: steadyInside,
      traces: [lateNotice, shown],
    }).result,
    "row-not-used",
  );
});

test("K6/4-N34: follow-up の失敗は失敗した段の理由で区分する（stale は鮮度、registration-unavailable は失効、ticket が available で T_late 超過はその他）", () => {
  const category = (row) => followUpFailureCategory(row, inTrace(row)).category;
  assert.equal(
    category(
      k64Sample(
        {},
        { parent: { ticket: staleTicket }, notices: [], child: null },
      ),
    ),
    "freshness",
  );
  assert.equal(
    category(
      k64Sample(
        {},
        {
          parent: {
            ticket: { ...staleTicket, reason: "registration-unavailable" },
          },
          notices: [],
          child: null,
        },
      ),
    ),
    "lapse",
  );
  assert.equal(
    category(
      k64Sample(
        {},
        {
          notices: [{ kind: "graph-ready", at: 300 }],
          child: { beginAt: 301 },
        },
      ),
    ),
    "other",
  );
  // 親の ticket の timeout など、挙げていない X1 の理由はその他（720 行）。
  assert.equal(
    category(
      k64Sample(
        {},
        {
          parent: { ticket: { ...staleTicket, reason: "timeout" } },
          notices: [],
          child: null,
        },
      ),
    ),
    "other",
  );
  // 子の合流の理由は 719-721 行の規則: 子の stale は鮮度。
  assert.equal(
    category(
      k64Sample(
        {},
        {
          child: {
            outcome: "graph-unavailable",
            reason: "stale",
            tGraph: null,
          },
        },
      ),
    ),
    "freshness",
  );
  // trace 全体: stale 12、T_late 超過 5、通知なし（ticket available）3 の 20 件。
  const mixed = traceK64(
    k64Trace("browsing", 200, (at) => {
      if (at < 12)
        return [
          {},
          { parent: { ticket: staleTicket }, notices: [], child: null },
        ];
      if (at < 17)
        return [
          {},
          {
            notices: [{ kind: "graph-ready", at: 300 }],
            child: { beginAt: 301 },
          },
        ];
      if (at < 20) return [{}, { notices: [], child: null }];
      return [{}, {}];
    }),
  );
  assert.deepEqual(mixed.categories, { lapse: 0, other: 8, freshness: 12 });
  assert.equal(mixed.mainReason, "freshness");
});

test("DR-CP4-K64-5 (A): (b) の follow-up が失効の段で落ちたものは親の query の失効として失効率に数える", () => {
  const cases = [
    [
      "parent-ticket-registration-unavailable",
      {
        parent: {
          ticket: { ...staleTicket, reason: "registration-unavailable" },
        },
        notices: [],
        child: null,
      },
      "i-b-seal",
    ],
    [
      "child-join-invalidated",
      {
        child: {
          outcome: "graph-unavailable",
          reason: "invalidated",
          requalification: "invalidated",
          tGraph: null,
        },
      },
      "iii-invalidated",
    ],
    [
      "child-join-registration-unavailable",
      {
        child: {
          outcome: "graph-unavailable",
          reason: "registration-unavailable",
          tGraph: null,
        },
      },
      "i-b-seal",
    ],
    [
      "child-requalification-invalidated",
      { child: { requalification: "invalidated" } },
      "iii-invalidated",
    ],
    [
      "child-empty-contribution",
      { child: { edgeCount: 0 } },
      "iv-empty-contribution",
    ],
    [
      "child-chronicle-stop",
      { child: { irOutcome: "index-unavailable" } },
      "i-chronicle-stop",
    ],
  ];
  for (const [question, followUp, kind] of cases) {
    const result = traceK64(
      k64Trace("editing", 200, (at) => (at === 5 ? [{}, followUp] : [{}, {}])),
    );
    assert.equal(result.status, "valid", question);
    assert.deepEqual(result.precheck, [], question);
    assert.equal(result.lapse.total, 1, question);
    assert.equal(result.lapse[kind], 1, question);
    assert.deepEqual(result.followUpLapse, { [question]: 1 }, question);
    assert.equal(result.outOfWindowU, 1, question);
    const decision = decideCp4Availability({
      steadyState: summarizeK64(k64Run()),
      traces: [result, traceK64(k64Trace("browsing", 200))],
    });
    assert.notEqual(decision.verdict, "precheck", question);
  }
  // 親の query が既に失効（開始時の B の seal）なら follow-up の失効を二重に数えない。
  const once = traceK64(
    k64Trace("editing", 200, (at) =>
      at === 5
        ? [
            { snapshot: { usable: false } },
            { child: { irOutcome: "index-unavailable" } },
          ]
        : [{}, {}],
    ),
  );
  assert.equal(once.lapse.total, 1);
  // 数えないと判定が変わる: 子の寄与の空（区分は「その他」）が 3 件で失効率が
  // 1% を越え、(iii) の診断は失効率の超過で止まる（数えなければ row-not-used）。
  const empty = traceK64(
    k64Trace("editing", 200, (at) =>
      at < 3 ? [{}, { child: { edgeCount: 0 } }] : [{}, {}],
    ),
  );
  assert.equal(empty.lapse["iv-empty-contribution"], 3);
  assert.equal(empty.lapseExceeds, true);
  const diagnosis = evaluateDiagnosticCondition({
    kind: "ii",
    steadyState: summarizeK64(k64Run()),
    traces: [empty, traceK64(k64Trace("browsing", 200))],
  });
  assert.deepEqual(
    [diagnosis.result, diagnosis.reason],
    ["precheck", "lapse-rate-exceeds"],
  );
});

test("D-2: (b) の trace でも遅れた結果の混入（N32、N1）は follow-up の成否と別に FAIL（K6/4:163）", () => {
  const mixed = traceK64(
    k64Trace("editing", 200, (at) => {
      if (at === 4) return [{}, { child: { publishCount: 2 } }];
      if (at === 9) return [{}, { parent: { lateGraphInDisplay: true } }];
      return [{}, {}];
    }),
  );
  assert.deepEqual(
    mixed.violations.map((row) => [row.queryId, row.code]),
    [
      ["q4", "N32:child-published-more-than-once"],
      ["q9", "N1:late-graph-in-parent-display"],
    ],
  );
  const steadyState = summarizeK64(k64Run());
  const browsing = traceK64(k64Trace("browsing", 200));
  const decision = decideCp4Availability({
    steadyState,
    traces: [mixed, browsing],
  });
  assert.deepEqual(
    [decision.verdict, decision.reason],
    ["FAIL", "late-result-mixed-into-a-display"],
  );
  const diagnosis = evaluateDiagnosticCondition({
    kind: "ii",
    steadyState,
    traces: [mixed, browsing],
  });
  assert.deepEqual(
    [diagnosis.result, diagnosis.reason],
    ["fail", "late-result-mixed-into-a-display"],
  );
  // 違反の無い trace は FAIL にならない。
  assert.deepEqual(browsing.violations, []);
});

test("(b) の K6/4 でも trace の不備（Q<200、queryId の重複、N16）は取り直し", () => {
  assert.equal(traceK64(k64Trace("browsing", 199)).status, "invalid");
  const duplicated = k64Trace("browsing", 200);
  duplicated.queries[7].queryId = "q6";
  assert.match(traceK64(duplicated).invalid.join(), /duplicate/);
  const lowLevel = k64Trace("browsing", 200, (at) =>
    at === 3 ? [{}, { issuedVia: "low-level-continue" }] : [{}, {}],
  );
  assert.match(traceK64(lowLevel).invalid.join(), /N16/);
});
