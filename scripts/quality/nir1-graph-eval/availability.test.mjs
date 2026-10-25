// Synthetic vectors only: no frozen G-case material is read or run here.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_VARIANT_KEYS,
  decideCp4Availability,
  evaluateDiagnosticCondition,
  graphCaseScheduleKeys,
  joinedWithinWindow,
  mainReason,
  steadyStateInWindow,
  summarizeSteadyState,
  summarizeTrace,
  validateGraphCaseSchedule,
  validateTraceEvents,
} from "./availability.mjs";
import {
  AVAILABILITY_YARDSTICK,
  GRAPH_EVAL_D_MS,
  GRAPH_EVAL_VARIANTS,
  GRAPH_RESULT_LEASE_MS,
  MEASURED_RUNS_PER_ARM,
  TRACE_MIN_QUERIES,
  WARMUP_RUNS_PER_ARM,
  exceedsYardstick,
} from "./constants.mjs";

const T_RAW_READY = 100;

/** A seeded, usable, in-window worker sample unless overridden. */
function sample(overrides = {}) {
  const { graph = {}, ...rest } = overrides;
  return {
    variantKey: "G-02/base",
    arm: "graph",
    phase: "measured",
    repeat: 0,
    trigger: "user-operation",
    seeded: true,
    graphEnabled: true,
    d2aMode: "restricted",
    tFetch: 90,
    tRawReady: T_RAW_READY,
    tReturn: 120,
    snapshot: { usable: true, reason: null },
    irOutcome: "ir-ready",
    a3AtStart: { eligible: true, reasons: [] },
    startSlot: { readyFresh: true },
    freshnessStamp: { matched: true, attemptedAt: 95 },
    recordRead: { startedAt: 80, finishedAt: 85 },
    expectedMaterials: ["rev-a"],
    ...rest,
    graph: {
      outcome: "graph-ready",
      reason: null,
      source: "worker",
      joined: true,
      arrivedAt: 105,
      revalidation: "passed",
      edgeCount: 2,
      busyCause: null,
      ...graph,
    },
  };
}

const late = (reason, extra = {}) => ({
  graph: {
    outcome: reason === "graph-late" ? "graph-late" : "graph-unavailable",
    reason: reason === "graph-late" ? null : reason,
    joined: false,
    arrivedAt: null,
    revalidation: null,
    edgeCount: null,
    ...extra,
  },
});

test("frozen constants are referenced, not chosen", () => {
  assert.equal(GRAPH_EVAL_D_MS, 10.84);
  assert.equal(GRAPH_RESULT_LEASE_MS, 100);
  assert.deepEqual(AVAILABILITY_YARDSTICK, { numerator: 1, denominator: 100 });
  assert.equal(WARMUP_RUNS_PER_ARM, 5);
  assert.equal(MEASURED_RUNS_PER_ARM, 30);
  assert.equal(TRACE_MIN_QUERIES, 200);
});

test("P-4: the window closes at t_raw_ready + D inclusive; a later joined result is refused", () => {
  assert.equal(
    joinedWithinWindow(sample({ graph: { arrivedAt: 110.84 } })),
    true,
  );
  assert.equal(joinedWithinWindow(sample({ graph: { arrivedAt: 100 } })), true);
  // D = 11 or a strict comparison would change these two vectors.
  assert.throws(
    () => joinedWithinWindow(sample({ graph: { arrivedAt: 110.85 } })),
    /late Graph result was mixed/,
  );
  assert.throws(
    () => joinedWithinWindow(sample({ graph: { arrivedAt: 110.9 } })),
    /N-7/,
  );
  assert.equal(
    joinedWithinWindow(sample(late("graph-late", { arrivedAt: 111 }))),
    false,
  );
  assert.throws(
    () =>
      joinedWithinWindow(sample({ graph: { revalidation: "invalidated" } })),
    /revalidation/,
  );
  assert.throws(
    () => joinedWithinWindow(sample({ tRawReady: 80, tFetch: 90 })),
    /monotonic/,
  );
});

test("N-7: a cache result is out of window in (a) even when joined in time", () => {
  assert.equal(steadyStateInWindow(sample()), true);
  assert.equal(
    steadyStateInWindow(sample({ graph: { source: "cache" } })),
    false,
  );
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
  const rows = keys.map((key) => {
    const [variantKey, phase, repeat, arm] = key.split(":");
    return sample({ variantKey, phase, repeat: Number(repeat), arm });
  });
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
});

/** 30 measured Graph samples for every catalog variant. */
function steadyRun(mutate = () => ({})) {
  const rows = [];
  for (const variant of GRAPH_EVAL_VARIANTS)
    for (let repeat = 0; repeat < 30; repeat++) {
      const unavailable = variant.expectedGraph === "unavailable";
      rows.push(
        sample({
          variantKey: variant.key,
          repeat,
          ...(unavailable
            ? {
                snapshot: { usable: false, reason: "graph-index-unusable" },
                ...late("registration-unavailable"),
              }
            : {}),
          ...mutate(variant, repeat),
        }),
      );
    }
  return rows;
}

test("P-5: (a) pools every available variant; case rates are disclosed only", () => {
  const pooledVariants = GRAPH_EVAL_VARIANTS.filter(
    (row) => row.expectedGraph !== "unavailable",
  );
  assert.equal(pooledVariants.length, 9);
  // Two late samples in two different cases: 2/270 is inside 1% even though
  // each case alone would be 1/30 = 3.3%.
  const two = steadyRun((variant, repeat) =>
    repeat === 0 && ["G-02/base", "G-04/base"].includes(variant.key)
      ? late("graph-late", { arrivedAt: 130 })
      : {},
  );
  const within = summarizeSteadyState({
    samples: two,
    fixedGraphMode: "restricted",
  });
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
  // Unavailable variants are measured but not pooled.
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
  assert.equal(
    summarizeSteadyState({ samples: three, fixedGraphMode: "restricted" }).pool
      .exceeds,
    true,
  );
});

test("(a) counts cache-origin and not-ready samples as out of window and keeps them", () => {
  const rows = steadyRun((variant, repeat) =>
    variant.key === "G-06/base" && repeat < 2
      ? { graph: { source: "cache" } }
      : variant.key === "G-06/base" && repeat === 2
        ? { startSlot: { readyFresh: false }, ...late("warming") }
        : {},
  );
  const summary = summarizeSteadyState({
    samples: rows,
    fixedGraphMode: "restricted",
  });
  const g06 = summary.cases.find((row) => row.variantKey === "G-06/base");
  assert.equal(g06.n, 30);
  assert.equal(g06.outOfWindow, 3);
  assert.equal(g06.cacheOrigin, 2);
  assert.equal(g06.notReadyAtStart, 1);
  assert.equal(summary.pool.exceeds, true);
});

test("a case with no in-window sample is quality HOLD", () => {
  const rows = steadyRun((variant) =>
    variant.key === "G-07/base" ? late("graph-late", { arrivedAt: 150 }) : {},
  );
  const summary = summarizeSteadyState({
    samples: rows,
    fixedGraphMode: "restricted",
  });
  assert.deepEqual(summary.qualityHoldVariants, ["G-07/base"]);
});

test("graph-ready re-queries and warm-ups never enter the (a) denominator", () => {
  const base = steadyRun();
  const extra = [
    ...Array.from({ length: 40 }, (_, repeat) =>
      sample({
        trigger: "graph-ready-requery",
        repeat,
        ...late("graph-late", { arrivedAt: 200 }),
      }),
    ),
    ...Array.from({ length: 5 }, (_, repeat) =>
      sample({ phase: "warmup", repeat, ...late("warming") }),
    ),
  ];
  const summary = summarizeSteadyState({
    samples: [...base, ...extra],
    fixedGraphMode: "restricted",
  });
  assert.equal(summary.pool.n, 270);
  assert.equal(summary.pool.outOfWindow, 0);
  assert.equal(summary.requeryCount, 40);
  assert.equal(summary.requeries.length, 40);
});

test("(a) refuses a run in another D2a mode or with a missing sample", () => {
  const rows = steadyRun((variant, repeat) =>
    variant.key === "G-02/base" && repeat === 0
      ? { d2aMode: "unrestricted" }
      : {},
  );
  assert.equal(
    summarizeSteadyState({ samples: rows, fixedGraphMode: "restricted" })
      .status,
    "invalid",
  );
  const short = steadyRun().filter(
    (row) => !(row.variantKey === "G-03/base" && row.repeat === 29),
  );
  const summary = summarizeSteadyState({
    samples: short,
    fixedGraphMode: "restricted",
  });
  assert.equal(summary.status, "invalid");
  assert.match(summary.invalid.join(" "), /29 measured/);
});

test("N-9: D, the lease and the yardstick cannot be passed as options", () => {
  for (const key of [
    "dMs",
    "D",
    "windowMs",
    "leaseMs",
    "yardstick",
    "lease-ms",
  ])
    assert.throws(
      () =>
        summarizeSteadyState({
          samples: [],
          fixedGraphMode: "restricted",
          [key]: 11,
        }),
      /\[precheck\].*frozen/,
    );
  assert.throws(
    () =>
      summarizeTrace({
        trace: { kind: "editing", queries: [] },
        fixedGraphMode: "restricted",
        d: 11,
      }),
    /\[precheck\]/,
  );
  assert.throws(
    () =>
      summarizeSteadyState({
        samples: [],
        fixedGraphMode: "restricted",
        extra: 1,
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
        recordRead: { startedAt: t0 + 1, finishedAt: t0 + 2 },
        freshnessStamp: { matched: true, attemptedAt: t0 + 5 },
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

test("P-9 rule 7, first example: 150 dirty seals give 0/50 out of window but 75% lapse", () => {
  const result = summarizeTrace({
    trace: trace("editing", 200, (at) => (at < 150 ? usableFalse : {})),
    fixedGraphMode: "restricted",
  });
  assert.equal(result.status, "valid");
  assert.deepEqual([result.Q, result.U, result.inWindow], [200, 50, 50]);
  assert.equal(result.outOfWindowRate, 0);
  assert.equal(result.outOfWindowExceeds, false);
  assert.equal(result.lapse["i-b-seal"], 150);
  assert.equal(result.lapse["ii-a3-ineligible-at-start"], 0);
  assert.equal(result.lapseRate, 0.75);
  assert.equal(result.lapseExceeds, true);
  // The 150 lapses are the window-out queries too and form the main reason.
  assert.equal(result.mainReason, "lapse");
});

test("P-9 rule 7, second example: 160 empty Graphs from A3-ineligible materials are lapses", () => {
  const result = summarizeTrace({
    trace: trace("editing", 200, (at) =>
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
    fixedGraphMode: "restricted",
  });
  assert.equal(result.inWindow, 200);
  assert.equal(result.outOfWindowRate, 0);
  assert.equal(result.lapse["ii-a3-ineligible-at-start"], 160);
  assert.equal(result.lapseRate, 0.8);
  assert.equal(result.lapseExceeds, true);
  assert.equal(result.a3IneligibleAtStart, 160);
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
  const result = summarizeTrace({
    trace: ruleSevenThird(5, 2, 12),
    fixedGraphMode: "restricted",
  });
  assert.equal(result.outOfWindow, 20);
  assert.equal(result.lapse.total, 1);
  assert.equal(result.lapse["iii-invalidated"], 1);
  assert.equal(result.lapseExceeds, false);
  assert.equal(result.outOfWindowExceeds, true);
  assert.deepEqual(result.categories, { lapse: 1, other: 7, freshness: 12 });
  assert.equal(result.mainReason, "freshness");
});

test("P-9 rule 7, fourth example: other exactly half is no main reason", () => {
  const result = summarizeTrace({
    trace: ruleSevenThird(6, 4, 9),
    fixedGraphMode: "restricted",
  });
  assert.deepEqual(result.categories, { lapse: 1, other: 10, freshness: 9 });
  assert.equal(result.mainReason, "none");
  assert.equal(mainReason({ lapse: 0, other: 10, freshness: 10 }, 20), "none");
  assert.equal(
    mainReason({ lapse: 0, other: 0, freshness: 11 }, 20),
    "freshness",
  );
});

test("P-9: an in-window empty contribution is lapse (iv), not window-out", () => {
  const result = summarizeTrace({
    trace: trace("browsing", 200, (at) =>
      at < 3 ? { graph: { edgeCount: 0 } } : {},
    ),
    fixedGraphMode: "restricted",
  });
  assert.equal(result.inWindow, 200);
  assert.equal(result.outOfWindow, 0);
  assert.equal(result.lapse["iv-empty-contribution"], 3);
  assert.equal(result.lapseExceeds, true);
});

test("U = 0 never satisfies the yardstick; Q = 199 is a trace defect, Q = 200 is judged", () => {
  const empty = summarizeTrace({
    trace: trace("editing", 200, () => usableFalse),
    fixedGraphMode: "restricted",
  });
  assert.equal(empty.U, 0);
  assert.equal(empty.outOfWindowExceeds, true);
  assert.equal(
    summarizeTrace({
      trace: trace("browsing", 199),
      fixedGraphMode: "restricted",
    }).status,
    "invalid",
  );
  const withRequeries = trace("browsing", 199);
  withRequeries.queries.push(
    ...Array.from({ length: 10 }, (_, at) =>
      sample({ queryId: `r${at}`, trigger: "graph-ready-requery" }),
    ),
  );
  const requeried = summarizeTrace({
    trace: withRequeries,
    fixedGraphMode: "restricted",
  });
  assert.equal(requeried.status, "invalid");
  assert.equal(requeried.requeryCount, 10);
  assert.equal(
    summarizeTrace({
      trace: trace("browsing", 200),
      fixedGraphMode: "restricted",
    }).status,
    "valid",
  );
});

test("rule 4: freshness-stamp busy is freshness only without a record-read overlap", () => {
  const busy = {
    ...late("busy", { busyCause: "freshness-stamp-read-failed" }),
  };
  const clear = summarizeTrace({
    trace: trace("browsing", 200, (at) => (at === 7 ? busy : {})),
    fixedGraphMode: "restricted",
  });
  assert.equal(clear.categories.freshness, 1);
  assert.equal(clear.busy.freshnessStamp, 1);
  // The stamp attempt at 7005 falls inside query 7's own record read.
  const overlapped = summarizeTrace({
    trace: trace("browsing", 200, (at, t0) =>
      at === 7
        ? { ...busy, recordRead: { startedAt: t0 + 4, finishedAt: t0 + 6 } }
        : {},
    ),
    fixedGraphMode: "restricted",
  });
  assert.equal(overlapped.categories.other, 1);
  assert.equal(overlapped.busy.overlapped, 1);
  // A missing record read anywhere in the trace makes the overlap undecidable.
  const missing = summarizeTrace({
    trace: trace("browsing", 200, (at) =>
      at === 7 ? busy : at === 150 ? { recordRead: null } : {},
    ),
    fixedGraphMode: "restricted",
  });
  assert.equal(missing.categories.other, 1);
  assert.equal(missing.busy.overlapRecordMissing, 1);
});

test("rule 4: graph-late splits by the start slot and stamp; Chronicle stop is a lapse", () => {
  const fresh = summarizeTrace({
    trace: trace("browsing", 200, (at) => (at === 1 ? late("graph-late") : {})),
    fixedGraphMode: "restricted",
  });
  assert.equal(fresh.categories.other, 1);
  const staleStart = summarizeTrace({
    trace: trace("browsing", 200, (at) =>
      at === 1
        ? { ...late("graph-late"), startSlot: { readyFresh: false } }
        : {},
    ),
    fixedGraphMode: "restricted",
  });
  assert.equal(staleStart.categories.freshness, 1);
  const chronicle = summarizeTrace({
    trace: trace("browsing", 200, (at) =>
      at === 1
        ? { irOutcome: "index-unavailable", ...late("not-activated") }
        : {},
    ),
    fixedGraphMode: "restricted",
  });
  assert.equal(chronicle.status, "valid");
  assert.equal(chronicle.lapse["i-chronicle-stop"], 1);
  assert.equal(chronicle.categories.lapse, 1);
  const defect = summarizeTrace({
    trace: trace("browsing", 200, (at) =>
      at === 1 ? late("profile-not-restricted") : {},
    ),
    fixedGraphMode: "restricted",
  });
  assert.equal(defect.status, "invalid");
});

const VALID_A = {
  status: "valid",
  pool: { n: 270, inWindow: 270, outOfWindow: 0, exceeds: false },
};
const EXCEEDING_A = {
  status: "valid",
  pool: { n: 270, inWindow: 10, outOfWindow: 260, exceeds: true },
};
const quietTrace = (kind) => ({
  kind,
  status: "valid",
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
    { ...quietTrace("editing"), lapseExceeds: true },
    { ...quietTrace("editing"), outOfWindowExceeds: true },
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

test("rule 6: lapse-rate precheck happens only inside a diagnostic, in order", () => {
  const file = { commit: "a".repeat(40), sha256: "b".repeat(64) };
  const lapsing = summarizeTrace({
    trace: trace("editing", 200, (at) => (at < 150 ? usableFalse : {})),
    fixedGraphMode: "restricted",
  });
  const browsing = summarizeTrace({
    trace: trace("browsing", 200),
    fixedGraphMode: "restricted",
  });
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
  const freshness = summarizeTrace({
    trace: ruleSevenThird(5, 2, 12),
    fixedGraphMode: "restricted",
  });
  const none = summarizeTrace({
    trace: ruleSevenThird(6, 4, 9),
    fixedGraphMode: "restricted",
  });
  const met = evaluateDiagnosticCondition({
    kind: "ii",
    steadyState: VALID_A,
    traces: [freshness, browsing],
  });
  assert.equal(met.result, "condition-met-confirmation-required");
  assert.equal(
    evaluateDiagnosticCondition({
      kind: "ii",
      steadyState: VALID_A,
      traces: [freshness, none],
    }).result,
    "precheck",
  );
  const other = summarizeTrace({
    trace: ruleSevenThird(9, 6, 4),
    fixedGraphMode: "restricted",
  });
  assert.equal(other.mainReason, "other");
  assert.equal(
    evaluateDiagnosticCondition({
      kind: "ii",
      steadyState: VALID_A,
      traces: [freshness, other],
    }).result,
    "row-not-used",
  );
  assert.equal(
    evaluateDiagnosticCondition({
      kind: "ii",
      steadyState: VALID_A,
      traces: [browsing, browsing],
    }).result,
    "condition-not-met",
  );
  assert.equal(
    evaluateDiagnosticCondition({
      kind: "ii",
      steadyState: EXCEEDING_A,
      traces: [lapsing],
    }).result,
    "row-not-used",
  );
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
    { type: "edit", via: "product-editor", at: at },
    { type: "autosave-commit", versionBefore: at, versionAfter: at + 1 },
    ...extra,
    { type: "query", trigger: "user-operation", issuedBy: "product" },
  ];
}

test("step 4 density: edit, autosave commit, then the product's own query", () => {
  const events = [
    { type: "query", trigger: "user-operation", issuedBy: "product" },
    ...round(1),
    { type: "query", trigger: "graph-ready-requery", issuedBy: "product" },
    ...round(2),
  ];
  assert.deepEqual(validateTraceEvents("editing", events), {
    queries: 3,
    errors: [],
  });
  const noCommit = [
    { type: "query", trigger: "user-operation", issuedBy: "product" },
    { type: "edit", via: "product-editor" },
    { type: "query", trigger: "user-operation", issuedBy: "product" },
  ];
  assert.match(
    validateTraceEvents("editing", noCommit).errors.join(),
    /no autosave commit/,
  );
  assert.match(
    validateTraceEvents("editing", [
      { type: "query", trigger: "user-operation", issuedBy: "product" },
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
      { type: "query", trigger: "user-operation", issuedBy: "product" },
      { type: "edit", via: "db-write" },
      { type: "autosave-commit", versionBefore: 1, versionAfter: 2 },
      { type: "query", trigger: "user-operation", issuedBy: "product" },
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

test("the catalog keys are the 13 variants", () => {
  assert.equal(ALL_VARIANT_KEYS.length, 13);
});
