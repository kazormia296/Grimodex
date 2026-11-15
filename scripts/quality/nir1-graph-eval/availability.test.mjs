// Synthetic vectors only: no frozen G-case material is read or run here.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyJoin,
  decideCp4Availability,
  evaluateDiagnosticCondition,
  graphCaseScheduleKeys,
  joinedWithinWindow,
  mainReason,
  readMainReason,
  k62SteadyStateInWindow,
  summarizeSteadyState,
  summarizeTrace,
  validateGraphCaseSchedule,
  validateTraceEvents,
} from "./availability.mjs";
import {
  AVAILABILITY_YARDSTICK,
  BOUNDARY_TOLERANCE_MS,
  GRAPH_EVAL_D_MS,
  GRAPH_EVAL_VARIANTS,
  GRAPH_RESULT_LEASE_MS,
  MEASURED_RUNS_PER_ARM,
  TRACE_MIN_QUERIES,
  WARMUP_RUNS_PER_ARM,
  exceedsYardstick,
} from "./constants.mjs";
import { late, sample, scheduleRows } from "./test-support.mjs";

const FROZEN = { kind: "frozen" };

test("frozen constants are referenced, not chosen", () => {
  assert.equal(GRAPH_EVAL_D_MS, 40);
  assert.equal(GRAPH_RESULT_LEASE_MS, 100);
  assert.equal(BOUNDARY_TOLERANCE_MS, 0.01);
  assert.deepEqual(AVAILABILITY_YARDSTICK, { numerator: 1, denominator: 100 });
  assert.equal(WARMUP_RUNS_PER_ARM, 5);
  assert.equal(MEASURED_RUNS_PER_ARM, 30);
  assert.equal(TRACE_MIN_QUERIES, 200);
  assert.equal(GRAPH_EVAL_VARIANTS.length, 13);
});

test("P-4: in window = joined and arrived by t_raw_ready + D inclusive", () => {
  assert.equal(
    joinedWithinWindow(sample({ graph: { arrivedAt: 100 + GRAPH_EVAL_D_MS } })),
    true,
  );
  assert.equal(joinedWithinWindow(sample({ graph: { arrivedAt: 100 } })), true);
  // D = 41 or a strict comparison would change these vectors.
  assert.deepEqual(
    classifyJoin(
      sample({ graph: { arrivedAt: 100 + GRAPH_EVAL_D_MS + 0.005 } }),
    ),
    {
      joined: true,
      inWindow: false,
      disagreement: "joined-late-within-tolerance",
    },
  );
  assert.throws(
    () =>
      classifyJoin(
        sample({ graph: { arrivedAt: 100 + GRAPH_EVAL_D_MS + 0.1 } }),
      ),
    /\[precheck\].*suspected N-7/,
  );
  assert.deepEqual(
    classifyJoin(sample(late("graph-late", { arrivedAt: 105 }))),
    {
      joined: false,
      inWindow: false,
      disagreement: "not-joined-in-time",
    },
  );
  assert.equal(
    classifyJoin(
      sample(late("graph-late", { arrivedAt: 100 + GRAPH_EVAL_D_MS + 1 })),
    ).disagreement,
    null,
  );
  assert.throws(
    () => classifyJoin(sample({ graph: { revalidation: "invalidated" } })),
    /revalidation/,
  );
  assert.throws(
    () => classifyJoin(sample({ tRawReady: 80, tFetch: 90 })),
    /monotonic/,
  );
  assert.throws(() => classifyJoin(sample(), 11), /only the sample/);
});

test("P1-4 / N-7: (a) counts only worker results that started on a fresh READY (K6/7 変える点 4: no stamp clause)", () => {
  assert.equal(k62SteadyStateInWindow(sample()), true);
  assert.equal(
    k62SteadyStateInWindow(sample({ graph: { source: "cache" } })),
    false,
  );
  // Joined in time, but the slot was not a new READY.
  assert.equal(
    k62SteadyStateInWindow(sample({ startSlot: { readyFresh: false } })),
    false,
  );
  // N-g: a stamp key of an old-form record is not read (no effect either way).
  for (const freshnessStamp of [
    { result: "stale", matched: false, attemptedAtNs: 95 },
    { result: "stamp0-missing", matched: null, attemptedAtNs: 95 },
    { result: "fresh", matched: true, attemptedAtNs: 95 },
  ])
    assert.equal(k62SteadyStateInWindow(sample({ freshnessStamp })), true);
  assert.equal(k62SteadyStateInWindow(sample({ startSlot: null })), false);
});

test("the 1% yardstick is an exact integer comparison", () => {
  assert.equal(exceedsYardstick(2, 200), false);
  assert.equal(exceedsYardstick(3, 200), true);
  assert.equal(exceedsYardstick(1, 100), false);
  assert.equal(exceedsYardstick(2, 100), true);
  assert.equal(exceedsYardstick(0, 0), true);
  assert.throws(() => exceedsYardstick(0.5, 100), /integers/);
});

test("the AB/BA schedule has 5 warm-ups and 30 measured repeats per arm", () => {
  const keys = graphCaseScheduleKeys("G-02/base");
  assert.equal(keys.length, (5 + 30) * 2);
  assert.deepEqual(keys.slice(0, 4), [
    "G-02/base:warmup:0:hybrid",
    "G-02/base:warmup:0:graph",
    "G-02/base:warmup:1:graph",
    "G-02/base:warmup:1:hybrid",
  ]);
  const rows = scheduleRows([GRAPH_EVAL_VARIANTS[1]]);
  validateGraphCaseSchedule(
    [...rows, sample({ trigger: "graph-ready-requery" })],
    ["G-02/base"],
  );
  const swapped = [...rows];
  [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  assert.throws(
    () => validateGraphCaseSchedule(swapped, ["G-02/base"]),
    /AB\/BA/,
  );
  assert.throws(
    () => validateGraphCaseSchedule(rows.slice(2), ["G-02/base"]),
    /AB\/BA/,
  );
  assert.throws(() => validateGraphCaseSchedule(rows, []), /names no variant/);
});

function steadyRun(mutate) {
  return scheduleRows(GRAPH_EVAL_VARIANTS, mutate);
}

function summarize(samples, extra = {}) {
  return summarizeSteadyState({
    samples,
    fixedGraphMode: "restricted",
    plan: FROZEN,
    ...extra,
  });
}

test("P-5: (a) pools every available variant; case rates are disclosed only", () => {
  // Two late samples in two different cases: 2/270 is inside 1% even though
  // each case alone would be 1/30 = 3.3%.
  const two = steadyRun((variant, repeat) =>
    repeat === 0 && ["G-02/base", "G-04/base"].includes(variant.key)
      ? late("graph-late", { arrivedAt: 130 })
      : {},
  );
  const within = summarize(two);
  assert.equal(within.status, "valid");
  assert.deepEqual(
    {
      n: within.pool.n,
      out: within.pool.outOfWindow,
      exceeds: within.pool.exceeds,
    },
    { n: 270, out: 2, exceeds: false },
  );
  const g02 = within.cases.find((row) => row.variantKey === "G-02/base");
  assert.equal(g02.outOfWindow, 1);
  assert.ok(Math.abs(g02.outOfWindowRate - 1 / 30) < 1e-12);
  assert.equal(
    within.cases.find((row) => row.variantKey === "G-08/graph-index-unusable")
      .inPool,
    false,
  );
  const three = steadyRun((variant, repeat) =>
    repeat === 0 &&
    ["G-02/base", "G-04/base", "G-05/base"].includes(variant.key)
      ? late("graph-late", { arrivedAt: 130 })
      : {},
  );
  assert.equal(summarize(three).pool.exceeds, true);
});

test("P1-4: not-READY samples joined in time are out of window and kept", () => {
  const rows = steadyRun((variant, repeat) =>
    variant.key !== "G-06/base"
      ? {}
      : repeat < 2
        ? { graph: { source: "cache" } }
        : repeat === 2
          ? { startSlot: { readyFresh: false } }
          : {},
  );
  const g06 = summarize(rows).cases.find(
    (row) => row.variantKey === "G-06/base",
  );
  assert.equal(g06.n, 30);
  assert.equal(g06.outOfWindow, 3);
  assert.equal(g06.cacheOrigin, 2);
  assert.equal(g06.notReadyAtStart, 1);
  assert.equal(Object.hasOwn(g06, "stampMismatch"), false);
  assert.equal(Object.hasOwn(g06, "stampResults"), false);
});

test("K6/7 N-g: a stamp key of an old-form record does not move the (a) count", () => {
  const rows = steadyRun((variant, repeat) =>
    variant.key === "G-06/base" && repeat < 2
      ? {
          freshnessStamp: {
            result: repeat === 0 ? "unavailable" : "stamp0-missing",
            matched: null,
            attemptedAtNs: 95,
          },
        }
      : {},
  );
  const g06 = summarize(rows).cases.find(
    (row) => row.variantKey === "G-06/base",
  );
  assert.equal(g06.outOfWindow, 0);
  const retired = steadyRun((variant, repeat) =>
    variant.key === "G-06/base" && repeat === 0
      ? late("busy", { busyCause: "freshness-stamp-read-failed" })
      : {},
  );
  // DR-DBC-7: the stamp read is gone, so the cause is no longer special-cased
  // here (an old `.node`'s record stops earlier, at native-sample.mjs, where
  // the cause is outside the Native's vocabulary).
  assert.doesNotThrow(() => summarize(retired));
});

test("a case with no in-window sample is quality HOLD", () => {
  const rows = steadyRun((variant) =>
    variant.key === "G-07/base" ? late("graph-late", { arrivedAt: 150 }) : {},
  );
  assert.deepEqual(summarize(rows).qualityHoldVariants, ["G-07/base"]);
});

test("P2-2: a frozen (a) needs all 13 variants' schedules; a dev plan is separate", () => {
  const missing = steadyRun().filter((row) => row.variantKey !== "G-03/base");
  assert.throws(() => summarize(missing), /AB\/BA schedule/);
  const short = steadyRun().filter(
    (row) =>
      !(
        row.variantKey === "G-03/base" &&
        row.repeat === 29 &&
        row.arm === "graph"
      ),
  );
  assert.throws(() => summarize(short), /AB\/BA schedule/);
  assert.throws(
    () => summarize(steadyRun(), { plan: { kind: "frozen", variants: [] } }),
    /always the 13/,
  );
  assert.throws(() => summarize(steadyRun(), { plan: null }), /frozen or dev/);
  const devKey = "dev:dev-g02.v1/base";
  const dev = scheduleRows([{ key: devKey, expectedGraph: "available" }]);
  const devSummary = summarize(dev, {
    plan: {
      kind: "dev",
      variants: [{ key: devKey, expectedGraph: "available" }],
    },
  });
  assert.equal(devSummary.planKind, "dev");
  assert.equal(devSummary.pool.n, 30);
  assert.throws(
    () =>
      summarize(dev, {
        plan: {
          kind: "dev",
          variants: [{ key: "G-02/base", expectedGraph: "available" }],
        },
      }),
    /dev variant key/,
  );
  assert.equal(
    decideCp4Availability({ steadyState: devSummary, traces: [] }).verdict,
    "preview-only",
  );
});

test("graph-ready re-queries never enter the (a) denominator", () => {
  const extra = Array.from({ length: 40 }, (_, repeat) =>
    sample({
      trigger: "graph-ready-requery",
      repeat,
      ...late("graph-late", { arrivedAt: 200 }),
    }),
  );
  const warmupsLate = steadyRun().map((row) =>
    row.phase === "warmup" && row.arm === "graph"
      ? { ...row, ...late("warming") }
      : row,
  );
  const summary = summarize([...warmupsLate, ...extra]);
  assert.equal(summary.pool.n, 270);
  assert.equal(summary.pool.outOfWindow, 0);
  assert.equal(summary.requeryCount, 40);
});

test("(a) refuses a run in another D2a mode", () => {
  const rows = steadyRun((variant, repeat) =>
    variant.key === "G-02/base" && repeat === 0
      ? { d2aMode: "unrestricted" }
      : {},
  );
  assert.equal(summarize(rows).status, "invalid");
});

test("boundary disagreements are counted in (a) and never stop a run within tolerance", () => {
  const rows = steadyRun((variant, repeat) =>
    variant.key === "G-02/base" && repeat === 0
      ? { graph: { arrivedAt: 100 + GRAPH_EVAL_D_MS + 0.005 } }
      : variant.key === "G-04/base" && repeat === 0
        ? late("graph-late", { arrivedAt: 105 })
        : {},
  );
  const summary = summarize(rows);
  assert.deepEqual(summary.boundaryDisagreement, {
    "not-joined-in-time": 1,
    "joined-late-within-tolerance": 1,
  });
  assert.equal(summary.pool.outOfWindow, 2);
  const beyond = steadyRun((variant, repeat) =>
    variant.key === "G-02/base" && repeat === 0
      ? { graph: { arrivedAt: 100 + GRAPH_EVAL_D_MS + 0.1 } }
      : {},
  );
  assert.throws(() => summarize(beyond), /suspected N-7/);
});

test("N-9 / P3: D, the lease, the yardstick and stray keys are refused", () => {
  for (const key of [
    "dMs",
    "D",
    "windowMs",
    "leaseMs",
    "yardstick",
    "lease-ms",
    "toleranceMs",
  ])
    assert.throws(() => summarize([], { [key]: 11 }), /\[precheck\].*frozen/);
  assert.throws(
    () =>
      summarizeTrace({
        trace: { kind: "editing", queries: [] },
        fixedGraphMode: "restricted",
        d: 11,
      }),
    /\[precheck\]/,
  );
  assert.throws(() => summarize([], { extra: 1 }), /unsupported option/);
  assert.throws(
    () => decideCp4Availability({ steadyState: null, traces: [], dMs: 11 }),
    /\[precheck\]/,
  );
  assert.throws(
    () =>
      evaluateDiagnosticCondition({
        kind: "ii",
        steadyState: null,
        traces: [],
        extra: true,
      }),
    /unsupported option/,
  );
});

/** A trace of `n` usable in-window queries with distinct record reads. */
function trace(kind, n, mutate = () => ({})) {
  return {
    kind,
    queries: Array.from({ length: n }, (_, at) => {
      const t0 = at * 1000;
      const { graph = {}, ...rest } = mutate(at, t0);
      return sample({
        queryId: `q${at}`,
        tFetch: t0,
        tRawReady: t0 + 10,
        tReturn: t0 + 30,
        // Native ns (a different clock from the renderer ms above).
        recordRead: { startedAtNs: t0 * 1e6 + 1, finishedAtNs: t0 * 1e6 + 2 },
        ...rest,
        graph: { arrivedAt: t0 + 15, ...graph },
      });
    }),
  };
}

const usableFalse = {
  snapshot: { usable: false, reason: "b-seal-dirty" },
  ...late("registration-unavailable"),
};
const traceOf = (value) =>
  summarizeTrace({ trace: value, fixedGraphMode: "restricted" });

test("P-9 rule 7, first example: 150 dirty seals give 0/50 out of window but 75% lapse", () => {
  const result = traceOf(
    trace("editing", 200, (at) => (at < 150 ? usableFalse : {})),
  );
  assert.equal(result.status, "valid");
  assert.deepEqual([result.Q, result.U, result.inWindow], [200, 50, 50]);
  assert.equal(result.outOfWindowRate, 0);
  assert.equal(result.outOfWindowExceeds, false);
  assert.equal(result.lapse["i-b-seal"], 150);
  assert.equal(result.lapseRate, 0.75);
  assert.equal(result.lapseExceeds, true);
  assert.equal(result.mainReason, "lapse");
});

test("P-9 rule 7, second example: 160 empty Graphs from A3-ineligible materials are lapses", () => {
  const result = traceOf(
    trace("editing", 200, (at) =>
      at < 160
        ? {
            a3AtStart: {
              eligible: false,
              reasons: ["source-revision-changed"],
            },
            graph: { edgeCount: 0 },
          }
        : {},
    ),
  );
  assert.equal(result.inWindow, 200);
  assert.equal(result.outOfWindowRate, 0);
  assert.equal(result.lapse["ii-a3-ineligible-at-start"], 160);
  assert.equal(result.lapseRate, 0.8);
  assert.equal(result.lapseExceeds, true);
});

function ruleSevenThird(otherBusy, timeouts, stale) {
  // One lapse (an invalidated cache result), 20 out of window in total.
  return trace("browsing", 200, (at) => {
    if (at === 0)
      return late("invalidated", {
        source: "cache",
        revalidation: "invalidated",
      });
    if (at <= stale) return late("stale");
    if (at <= stale + otherBusy)
      return late("busy", { busyCause: "slot-in-use" });
    if (at <= stale + otherBusy + timeouts) return late("timeout");
    return {};
  });
}

test("P-9 rule 7, third example: stale 12 of 20 is a freshness majority", () => {
  const result = traceOf(ruleSevenThird(5, 2, 12));
  assert.equal(result.outOfWindow, 20);
  assert.equal(result.lapse["iii-invalidated"], 1);
  assert.equal(result.lapseExceeds, false);
  assert.equal(result.outOfWindowExceeds, true);
  assert.deepEqual(result.categories, { lapse: 1, other: 7, freshness: 12 });
  // K6/7 変える点 7 (b): rule 5's majority is "freshness"; rule 6 reads "other".
  assert.equal(result.mainReasonBeforeReading, "freshness");
  assert.equal(result.mainReason, "other");
});

test("P-9 rule 7, fourth example: other exactly half is no main reason", () => {
  const result = traceOf(ruleSevenThird(6, 4, 9));
  assert.deepEqual(result.categories, { lapse: 1, other: 10, freshness: 9 });
  assert.equal(result.mainReason, "none");
  assert.equal(result.mainReasonBeforeReading, "none");
  assert.equal(mainReason({ lapse: 0, other: 10, freshness: 10 }, 20), "none");
  assert.equal(
    mainReason({ lapse: 0, other: 0, freshness: 11 }, 20),
    "freshness",
  );
});

test("P-9 / P2-3: an empty contribution is lapse (iv); a joined result without an edge count is a defect", () => {
  const result = traceOf(
    trace("browsing", 200, (at) => (at < 3 ? { graph: { edgeCount: 0 } } : {})),
  );
  assert.equal(result.inWindow, 200);
  assert.equal(result.lapse["iv-empty-contribution"], 3);
  assert.equal(result.lapseExceeds, true);
  for (const edgeCount of [null, undefined, 1.5, -1]) {
    const missing = traceOf(
      trace("browsing", 200, (at) =>
        at === 4 ? { graph: { edgeCount } } : {},
      ),
    );
    assert.equal(missing.status, "invalid", String(edgeCount));
    assert.match(missing.invalid.join(), /edge count/);
  }
});

test("U = 0 never satisfies the yardstick; Q = 199 is a trace defect, Q = 200 is judged", () => {
  const empty = traceOf(trace("editing", 200, () => usableFalse));
  assert.equal(empty.U, 0);
  assert.equal(empty.outOfWindowExceeds, true);
  assert.equal(traceOf(trace("browsing", 199)).status, "invalid");
  const withRequeries = trace("browsing", 199);
  withRequeries.queries.push(
    ...Array.from({ length: 10 }, (_, at) =>
      sample({ queryId: `r${at}`, trigger: "graph-ready-requery" }),
    ),
  );
  const requeried = traceOf(withRequeries);
  assert.equal(requeried.status, "invalid");
  assert.equal(requeried.requeryCount, 10);
  assert.equal(traceOf(trace("browsing", 200)).status, "valid");
});

test("K6/7 N-h1・N-g: a graph-late is read by the start slot alone (readyFresh false is freshness, true is other); a stamp key never moves a category", () => {
  const stale = traceOf(
    trace("browsing", 200, (at) =>
      at === 7
        ? { ...late("graph-late"), startSlot: { readyFresh: false } }
        : {},
    ),
  );
  assert.equal(stale.categories.freshness, 1);
  assert.equal(stale.reasons["graph-late:stale-start"], 1);
  const fresh = traceOf(
    trace("browsing", 200, (at) =>
      at === 7
        ? { ...late("graph-late"), startSlot: { readyFresh: true } }
        : {},
    ),
  );
  assert.equal(fresh.categories.other, 1);
  assert.equal(fresh.reasons["graph-late:fresh-start"], 1);
  const missing = traceOf(
    trace("browsing", 200, (at) =>
      at === 7 ? { ...late("graph-late"), startSlot: null } : {},
    ),
  );
  assert.equal(missing.reasons["graph-late:start-record-missing"], 1);
  // N-g: an old-form stamp key (any result) changes neither the category nor
  // the reason, and the record keeps no stamp field.
  for (const freshnessStamp of [
    { result: "unavailable", matched: null, attemptedAtNs: 1 },
    { result: "stamp0-missing", matched: null, attemptedAtNs: 1 },
    { result: "stale", matched: false, attemptedAtNs: 1 },
    { result: "fresh", matched: true, attemptedAtNs: 1 },
  ]) {
    const withKey = traceOf(
      trace("browsing", 200, (at) =>
        at === 7
          ? {
              ...late("graph-late"),
              startSlot: { readyFresh: false },
              freshnessStamp,
            }
          : {},
      ),
    );
    assert.deepEqual(withKey.categories, stale.categories);
    assert.deepEqual(withKey.reasons, stale.reasons);
    assert.equal(Object.hasOwn(withKey, "stampWithoutComparison"), false);
  }
});

test("K6/7 N-h2: a majority of freshness is read as other, and rule 6 does not use the last branch", () => {
  // stale 12 of 20, the lapse rate within the yardstick: main reason freshness
  // before the reading, other after it.
  const freshness = traceOf(ruleSevenThird(5, 2, 12));
  assert.equal(freshness.categories.freshness, 12);
  assert.equal(freshness.mainReasonBeforeReading, "freshness");
  assert.equal(freshness.mainReason, "other");
  const decision = evaluateDiagnosticCondition({
    kind: "ii",
    steadyState: VALID_A,
    traces: [freshness, traceOf(ruleSevenThird(5, 2, 12))],
  });
  assert.equal(decision.result, "row-not-used");
  assert.equal(decision.reason, "main-reason-other");
  assert.deepEqual(decision.mains, ["other", "other"]);
  assert.deepEqual(decision.mainsBeforeReading, ["freshness", "freshness"]);
});

/**
 * A trace of 1,200 queries (so that the lapses stay within the 1% yardstick
 * and rule 6 reaches the main reasons) with `lapse` lapses (invalidated cache
 * results), then `freshness` stale and `other` timeouts out of window.
 */
function mixedTrace({ lapse, freshness, other }) {
  return trace("browsing", 1200, (at) => {
    if (at < lapse)
      return late("invalidated", {
        source: "cache",
        revalidation: "invalidated",
      });
    if (at < lapse + freshness) return late("stale");
    if (at < lapse + freshness + other) return late("timeout");
    return {};
  });
}

test("K6/7 攻撃 33: 規則 6 は要約の主な理由「鮮度」（手組み・旧形）も「その他」と読み、最後の枝（条件成立）に届かない", () => {
  const handBuilt = {
    ...quietTrace("editing"),
    Q: 200,
    U: 200,
    outOfWindowU: 20,
    outOfWindowExceeds: true,
    mainReason: "freshness",
  };
  const decision = evaluateDiagnosticCondition({
    kind: "ii",
    steadyState: VALID_A,
    traces: [handBuilt, quietTrace("browsing")],
  });
  assert.equal(decision.result, "row-not-used");
  assert.equal(decision.reason, "main-reason-other");
  assert.deepEqual(decision.mains, ["other"]);
  assert.deepEqual(decision.mainsBeforeReading, ["freshness"]);
  // The reading is idempotent and only moves "freshness".
  for (const [before, after] of [
    ["freshness", "other"],
    ["other", "other"],
    ["lapse", "lapse"],
    ["none", "none"],
    [null, null],
  ])
    assert.equal(readMainReason(before), after);
});

test("K6/7 N-h7: 主な理由が未設定・未知・null の超過 trace と readMainReason は [artifact] で、最後の枝（条件成立）に落ちない", () => {
  for (const bad of [undefined, "unknown", "", "Freshness", 0])
    assert.throws(
      () => readMainReason(bad),
      /\[artifact\]/,
      `readMainReason(${String(bad)})`,
    );
  assert.equal(readMainReason(null), null);
  for (const bad of [undefined, "unknown", "", null]) {
    const built = {
      ...quietTrace("editing"),
      Q: 200,
      U: 200,
      outOfWindowU: 20,
      outOfWindowExceeds: true,
    };
    if (bad !== undefined) built.mainReason = bad;
    assert.throws(
      () =>
        evaluateDiagnosticCondition({
          kind: "ii",
          steadyState: VALID_A,
          traces: [built, quietTrace("browsing")],
        }),
      /\[artifact\]/,
      `a trace whose main reason is ${String(bad)}`,
    );
  }
});

test("K6/7 N-h5: freshness 9, other 8, lapse 3 has no majority; the reading does not fold freshness into other first", () => {
  const result = traceOf(mixedTrace({ lapse: 3, freshness: 9, other: 8 }));
  assert.equal(result.outOfWindow, 20);
  assert.deepEqual(result.categories, { lapse: 3, other: 8, freshness: 9 });
  assert.equal(result.mainReasonBeforeReading, "none");
  assert.equal(result.mainReason, "none");
  const decision = evaluateDiagnosticCondition({
    kind: "ii",
    steadyState: VALID_A,
    traces: [result, traceOf(trace("browsing", 200))],
  });
  assert.equal(decision.result, "precheck");
  assert.equal(decision.reason, "main-reason-lapse-or-none");
  assert.deepEqual(decision.mains, ["none"]);
});

test("K6/7 N-h6: lapse 11 and other 9 is a lapse majority; a lapse is never folded into other", () => {
  const result = traceOf(mixedTrace({ lapse: 11, freshness: 0, other: 9 }));
  assert.equal(result.outOfWindow, 20);
  assert.deepEqual(result.categories, { lapse: 11, other: 9, freshness: 0 });
  assert.equal(result.mainReason, "lapse");
  assert.equal(result.mainReasonBeforeReading, "lapse");
  const decision = evaluateDiagnosticCondition({
    kind: "ii",
    steadyState: VALID_A,
    traces: [result, traceOf(trace("browsing", 200))],
  });
  assert.equal(decision.result, "precheck");
  assert.equal(decision.reason, "main-reason-lapse-or-none");
  assert.deepEqual(decision.mains, ["lapse"]);
});

test("a Busy is category other whatever its cause (no stamp-read special case since DR-DBC-7)", () => {
  const retired = late("busy", { busyCause: "freshness-stamp-read-failed" });
  const result = traceOf(
    trace("browsing", 200, (at) => (at === 7 ? retired : {})),
  );
  assert.equal(result.categories.other, 1);
  assert.equal(result.categories.freshness, 0);
  // Other Busy causes stay "other".
  const busy = traceOf(
    trace("browsing", 200, (at) =>
      at === 7 ? late("busy", { busyCause: "worker-capacity" }) : {},
    ),
  );
  assert.equal(busy.categories.other, 1);
  assert.equal(busy.busy.causes["worker-capacity"], 1);
});

test("DR-CP4-S1C1-10: the Native ns fields never move the window", () => {
  const base = sample();
  const shifted = sample({
    recordRead: { startedAtNs: 1, finishedAtNs: 9_999_999_999 },
  });
  assert.deepEqual(classifyJoin(shifted), classifyJoin(base));
});

test("K6/2 の文のまま（批准 5 を欠く候補、変える点 12）: graph-late は開始時の slot と stamp で分ける。K6/4 の候補では使わない（followup.test.mjs の N33）", () => {
  assert.equal(
    traceOf(
      trace("browsing", 200, (at) => (at === 1 ? late("graph-late") : {})),
    ).categories.other,
    1,
  );
  assert.equal(
    traceOf(
      trace("browsing", 200, (at) =>
        at === 1
          ? { ...late("graph-late"), startSlot: { readyFresh: false } }
          : {},
      ),
    ).categories.freshness,
    1,
  );
  const chronicle = traceOf(
    trace("browsing", 200, (at) =>
      at === 1
        ? { irOutcome: "index-unavailable", ...late("not-activated") }
        : {},
    ),
  );
  assert.equal(chronicle.status, "valid");
  assert.equal(chronicle.lapse["i-chronicle-stop"], 1);
  assert.equal(
    traceOf(
      trace("browsing", 200, (at) =>
        at === 1 ? late("profile-not-restricted") : {},
      ),
    ).status,
    "invalid",
  );
});

test("boundary disagreements in (b): joined-late within tolerance is other, never a lapse", () => {
  const result = traceOf(
    trace("browsing", 200, (at, t0) =>
      at === 1
        ? { graph: { arrivedAt: t0 + 10 + GRAPH_EVAL_D_MS + 0.005 } }
        : at === 2
          ? late("graph-late", { arrivedAt: 2015 })
          : {},
    ),
  );
  assert.deepEqual(result.boundaryDisagreement, {
    "not-joined-in-time": 1,
    "joined-late-within-tolerance": 1,
  });
  assert.equal(result.reasons["boundary-disagreement:joined-late"], 1);
  assert.equal(result.categories.other, 2);
});

const VALID_A = {
  status: "valid",
  planKind: "frozen",
  pool: { n: 270, inWindow: 270, outOfWindow: 0, exceeds: false },
};
const EXCEEDING_A = {
  status: "valid",
  planKind: "frozen",
  pool: { n: 270, inWindow: 10, outOfWindow: 260, exceeds: true },
};
const quietTrace = (kind) => ({
  kind,
  status: "valid",
  Q: 200,
  U: 200,
  outOfWindowU: 0,
  lapse: { total: 0 },
  outOfWindowExceeds: false,
  lapseExceeds: false,
  outOfWindowRate: 0,
  lapseRate: 0,
});

test("§15.4: (a) above 1% is HOLD and the trace values are only recorded", () => {
  const lapsing = {
    ...quietTrace("editing"),
    lapseExceeds: true,
    lapseRate: 0.75,
  };
  const decision = decideCp4Availability({
    steadyState: EXCEEDING_A,
    traces: [lapsing, quietTrace("browsing")],
  });
  assert.equal(decision.verdict, "HOLD");
  assert.equal(decision.reason, "steady-state-out-of-window-rate-exceeds");
  assert.equal(decision.traceValues, "recorded-and-disclosed-only");
  assert.equal(decision.iiiDiagnosticRequired, false);
  assert.equal(decision.disclose.traces[0].lapseRate, 0.75);
  assert.ok(!JSON.stringify(decision).includes("precheck"));
});

test("§15.4: (a) inside with a trace above 1% is HOLD with the (iii) diagnostic, never precheck", () => {
  for (const exceeding of [
    { ...quietTrace("editing"), lapse: { total: 3 }, lapseExceeds: true },
    { ...quietTrace("editing"), outOfWindowU: 3, outOfWindowExceeds: true },
  ]) {
    const decision = decideCp4Availability({
      steadyState: VALID_A,
      traces: [exceeding, quietTrace("browsing")],
    });
    assert.equal(decision.verdict, "HOLD");
    assert.equal(decision.iiiDiagnosticRequired, true);
    assert.ok(!JSON.stringify(decision).includes("precheck"));
  }
  assert.equal(
    decideCp4Availability({
      steadyState: VALID_A,
      traces: [quietTrace("editing"), quietTrace("browsing")],
    }).verdict,
    "no-yardstick-trigger",
  );
  assert.equal(
    decideCp4Availability({
      steadyState: VALID_A,
      traces: [quietTrace("browsing")],
    }).reason,
    "editing-trace-not-measured",
  );
  assert.equal(
    decideCp4Availability({ steadyState: VALID_A, traces: null }).reason,
    "traces-not-measured",
  );
});

test("P2-5: 要約の件数が欠けたら trigger なしと読まず、件数から計算し直す", () => {
  // 自己申告の exceeds:false でも、件数が物差しを超えていれば HOLD。
  const lying = {
    ...quietTrace("editing"),
    outOfWindowU: 3,
    outOfWindowExceeds: false,
  };
  assert.equal(
    decideCp4Availability({
      steadyState: VALID_A,
      traces: [lying, quietTrace("browsing")],
    }).reason,
    "trace-exceeds-yardstick",
  );
  const hiddenPool = {
    ...EXCEEDING_A,
    pool: { ...EXCEEDING_A.pool, exceeds: false },
  };
  assert.equal(
    decideCp4Availability({ steadyState: hiddenPool, traces: [] }).reason,
    "steady-state-out-of-window-rate-exceeds",
  );
  for (const missing of [
    { ...quietTrace("editing"), U: undefined },
    { ...quietTrace("editing"), lapse: undefined },
    {
      kind: "editing",
      status: "valid",
      outOfWindowExceeds: false,
      lapseExceeds: false,
    },
  ])
    assert.throws(
      () =>
        decideCp4Availability({
          steadyState: VALID_A,
          traces: [missing, quietTrace("browsing")],
        }),
      /lacks its counts/,
    );
  assert.throws(
    () =>
      decideCp4Availability({
        steadyState: {
          status: "valid",
          planKind: "frozen",
          pool: { exceeds: false },
        },
        traces: [],
      }),
    /lacks its counts/,
  );
});

test("P3-8: t_fetch より前の Graph の到着はこの query の答えではない", () => {
  assert.throws(
    () => classifyJoin(sample({ graph: { arrivedAt: 80 } })),
    /precedes t_fetch/,
  );
  assert.throws(
    () => classifyJoin(sample(late("graph-late", { arrivedAt: 50 }))),
    /precedes t_fetch/,
  );
});

test("P3-9: queryId の重複で Q≥200 を満たせない", () => {
  const twice = trace("browsing", 200);
  twice.queries[10].queryId = "q9";
  const result = traceOf(twice);
  assert.equal(result.status, "invalid");
  assert.match(result.invalid.join(), /duplicate queryId/);
  const unnamed = trace("browsing", 200);
  delete unnamed.queries[3].queryId;
  assert.match(traceOf(unnamed).invalid.join(), /lacks its queryId/);
});

test("rule 6: lapse-rate precheck happens only inside a diagnostic, in order", () => {
  const file = { commit: "a".repeat(40), sha256: "b".repeat(64) };
  const lapsing = traceOf(
    trace("editing", 200, (at) => (at < 150 ? usableFalse : {})),
  );
  const browsing = traceOf(trace("browsing", 200));
  const precheck = evaluateDiagnosticCondition({
    kind: "iii",
    steadyState: VALID_A,
    traces: [lapsing, browsing],
    traceFile: file,
    cp4TraceFile: file,
  });
  assert.equal(precheck.result, "precheck");
  assert.equal(precheck.traces[0].indexRebuildWait, 150);
  assert.equal(precheck.traces[0].approvalLapse, 0);
  const freshness = traceOf(ruleSevenThird(5, 2, 12));
  const none = traceOf(ruleSevenThird(6, 4, 9));
  const diagnose = (traces, steadyState = VALID_A) =>
    evaluateDiagnosticCondition({ kind: "ii", steadyState, traces }).result;
  // K6/7 変える点 7 (b): the freshness majority is read as "other".
  assert.equal(diagnose([freshness, browsing]), "row-not-used");
  assert.equal(diagnose([freshness, none]), "precheck");
  const other = traceOf(ruleSevenThird(9, 6, 4));
  assert.equal(other.mainReason, "other");
  assert.equal(diagnose([freshness, other]), "row-not-used");
  assert.equal(diagnose([browsing, browsing]), "condition-not-met");
  assert.equal(diagnose([lapsing], EXCEEDING_A), "row-not-used");
  assert.throws(
    () =>
      evaluateDiagnosticCondition({
        kind: "iii",
        steadyState: VALID_A,
        traces: [browsing],
        traceFile: { ...file, sha256: "c".repeat(64) },
        cp4TraceFile: file,
      }),
    /reuse the trace file/,
  );
});

function round(at, extra = []) {
  return [
    { type: "edit", via: "product-editor", at },
    { type: "autosave-commit", versionBefore: at, versionAfter: at + 1 },
    ...extra,
    { type: "query", trigger: "user-operation", issuedBy: "product" },
  ];
}

const firstQuery = {
  type: "query",
  trigger: "user-operation",
  issuedBy: "product",
};

test("step 4 density: edit, autosave commit, then the product's own query", () => {
  const events = [
    firstQuery,
    ...round(1),
    { type: "query", trigger: "graph-ready-requery", issuedBy: "product" },
    ...round(2),
  ];
  assert.deepEqual(validateTraceEvents("editing", events), {
    queries: 3,
    errors: [],
  });
  assert.match(
    validateTraceEvents("editing", [
      firstQuery,
      { type: "edit", via: "product-editor" },
      firstQuery,
    ]).errors.join(),
    /no autosave commit/,
  );
  assert.match(
    validateTraceEvents("editing", [
      firstQuery,
      ...round(1, [{ type: "harness-wait", ms: 50 }]),
    ]).errors.join(),
    /harness wait/,
  );
  assert.match(
    validateTraceEvents("editing", [
      ...round(1),
      { type: "approval" },
    ]).errors.join(),
    /approval/,
  );
  assert.match(
    validateTraceEvents("editing", [
      firstQuery,
      { type: "edit", via: "db-write" },
      { type: "autosave-commit", versionBefore: 1, versionAfter: 2 },
      firstQuery,
    ]).errors.join(),
    /product editor/,
  );
  assert.match(
    validateTraceEvents("browsing", round(1)).errors.join(),
    /browsing trace must not edit/,
  );
  assert.match(
    validateTraceEvents("browsing", [
      { type: "query", trigger: "user-operation", issuedBy: "harness" },
    ]).errors.join(),
    /not issued by the product/,
  );
});
