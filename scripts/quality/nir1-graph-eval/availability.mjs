// CP-4 Graph availability: K6/2 `graph-eval-procedure` measurement steps 1-9
// and "(b) の判定の規則" 1-8, applied to recorded samples.
//
// Pure module: it classifies samples that a harness already recorded and
// never observes a runtime. Every rule is the frozen K6/2 text; D, the lease,
// the 1% yardstick, the boundary tolerance and the run counts come from
// constants.mjs only.
//
// Sample record (one Related Scenes query of one arm):
//   variantKey, arm ("hybrid" | "graph"), phase ("warmup" | "measured"),
//   repeat, trigger ("user-operation" | "graph-ready-requery" |
//   "index-ready-requery"), seeded, graphEnabled, d2aMode,
//   tFetch, tRawReady, tReturn            renderer performance.now() ms
//   snapshot: { usable, reason }          B seal current at start
//   irOutcome                             same query's IR outcome
//   a3AtStart: { eligible, reasons }      expected materials at start
//   startSlot: { readyFresh }             owner slot was a new READY
//   freshnessStamp: { matched, attemptedAt }
//   recordRead: { startedAt, finishedAt } read-only record connection
//   graph: { outcome, reason, source, joined, arrivedAt, revalidation,
//            edgeCount, busyCause }       arrivedAt: the same renderer clock
//                                         the product's join helper compared
//   finalSceneIds                         the returned final list
//   expectedMaterials                     trace queries only

import {
  BOUNDARY_TOLERANCE_MS,
  GRAPH_CASE_ARMS,
  GRAPH_EVAL_D_MS,
  MEASURED_RUNS_PER_ARM,
  TRACE_MIN_QUERIES,
  WARMUP_RUNS_PER_ARM,
  exceedsYardstick,
  ratio,
  rejectOverrides,
  resolvePlan,
} from "./constants.mjs";

const USER_OPERATION = "user-operation";
const SETUP_DEFECT_REASONS = new Set([
  "not-requested",
  "not-activated",
  "profile-not-restricted",
]);
const FRESHNESS_REASONS = new Set(["stale", "warming"]);
const FRESHNESS_STAMP_BUSY = "freshness-stamp-read-failed";
export const BOUNDARY_DISAGREEMENTS = Object.freeze({
  notJoinedInTime: "not-joined-in-time",
  joinedLateWithinTolerance: "joined-late-within-tolerance",
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Join classification of one sample (K6/2 step 5 and the integrator's
 * boundary decision). In window = the product joined the result AND its
 * arrival is at or before `t_raw_ready + D`. Two disagreements are kept:
 * not joined although in time (a plain window-out, disclosed), and joined
 * although late within the 10 µs tolerance (conservatively window-out,
 * disclosed). Joined and later than the tolerance stops with `[precheck]`
 * as a suspected product N-7 violation.
 */
export function classifyJoin(sample, ...extra) {
  if (extra.length > 0)
    throw new Error(
      "[precheck] classifyJoin takes only the sample (D is frozen)",
    );
  if (!finite(sample?.tFetch) || !finite(sample?.tRawReady))
    throw new Error("[artifact] sample lacks t_fetch / t_raw_ready");
  if (!finite(sample.tReturn))
    throw new Error("[artifact] sample lacks t_return");
  if (
    !(sample.tFetch <= sample.tRawReady && sample.tRawReady <= sample.tReturn)
  )
    throw new Error("[artifact] sample timestamps are not monotonic");
  const graph = sample.graph;
  if (!graph || typeof graph.joined !== "boolean")
    throw new Error("[artifact] sample lacks the Graph join record");
  const deadline = sample.tRawReady + GRAPH_EVAL_D_MS;
  if (!graph.joined) {
    const inTime = finite(graph.arrivedAt) && graph.arrivedAt <= deadline;
    return {
      joined: false,
      inWindow: false,
      disagreement: inTime ? BOUNDARY_DISAGREEMENTS.notJoinedInTime : null,
    };
  }
  if (graph.revalidation !== "passed")
    throw new Error(
      "[artifact] a Graph result that did not pass return-time revalidation was joined",
    );
  if (!finite(graph.arrivedAt))
    throw new Error("[artifact] joined Graph result lacks its arrival time");
  if (graph.arrivedAt <= deadline)
    return { joined: true, inWindow: true, disagreement: null };
  if (graph.arrivedAt <= deadline + BOUNDARY_TOLERANCE_MS)
    return {
      joined: true,
      inWindow: false,
      disagreement: BOUNDARY_DISAGREEMENTS.joinedLateWithinTolerance,
    };
  throw new Error(
    "[precheck] the product joined a Graph result later than t_raw_ready + D beyond the boundary tolerance (suspected N-7)",
  );
}

export function joinedWithinWindow(sample) {
  return classifyJoin(sample).inWindow;
}

/**
 * (a): only a worker result of this query's ticket, started on a new READY
 * with a matching freshness stamp, counts as in-window (K6/2 step 3).
 */
export function steadyStateInWindow(sample) {
  return (
    classifyJoin(sample).inWindow &&
    sample.graph.source === "worker" &&
    sample.startSlot?.readyFresh === true &&
    sample.freshnessStamp?.matched === true
  );
}

/** The predeclared AB/BA order for one variant (K6/2 step 2, P schedule). */
export function graphCaseScheduleKeys(variantKey) {
  const keys = [];
  for (const [phase, count] of [
    ["warmup", WARMUP_RUNS_PER_ARM],
    ["measured", MEASURED_RUNS_PER_ARM],
  ])
    for (let repeat = 0; repeat < count; repeat++) {
      const arms =
        repeat % 2 === 0 ? GRAPH_CASE_ARMS : [...GRAPH_CASE_ARMS].reverse();
      for (const arm of arms)
        keys.push(`${variantKey}:${phase}:${repeat}:${arm}`);
    }
  return keys;
}

/** Re-queries are recorded separately and never scheduled. */
export function validateGraphCaseSchedule(samples, variantKeys) {
  if (!Array.isArray(variantKeys) || variantKeys.length === 0)
    throw new Error("[artifact] the schedule names no variant");
  const actual = samples
    .filter((sample) => sample.trigger === USER_OPERATION)
    .map(
      (sample) =>
        `${sample.variantKey}:${sample.phase}:${sample.repeat}:${sample.arm}`,
    );
  const expected = variantKeys.flatMap(graphCaseScheduleKeys);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      "[artifact] variant/phase/repeat/arm order differs from the predeclared AB/BA schedule",
    );
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = key(row) ?? "none";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/**
 * Splits re-query rows (`graph-ready` / `index-ready`) from the rows that
 * enter any denominator. Re-query rows go to the D5/A3 column only.
 */
export function separateRequeries(samples) {
  const counted = [];
  const requeries = [];
  for (const sample of samples)
    (sample.trigger === USER_OPERATION ? counted : requeries).push(sample);
  for (const row of requeries)
    if (
      row.trigger !== "graph-ready-requery" &&
      row.trigger !== "index-ready-requery"
    )
      throw new Error(`[artifact] unknown query trigger ${row.trigger}`);
  return { counted, requeries };
}

function emptyDisagreement() {
  return {
    [BOUNDARY_DISAGREEMENTS.notJoinedInTime]: 0,
    [BOUNDARY_DISAGREEMENTS.joinedLateWithinTolerance]: 0,
  };
}

/**
 * The (a) record of one variant from its measured R+IR+Graph samples.
 * Returns the case entry and the reasons that invalidate the run.
 */
export function summarizeSteadyStateCase({ rows, variant, fixedGraphMode }) {
  const invalid = [];
  const measured = rows.filter(
    (row) =>
      row.arm === "graph" &&
      row.trigger === USER_OPERATION &&
      row.phase === "measured" &&
      row.variantKey === variant.key,
  );
  const entry = {
    variantKey: variant.key,
    inPool: variant.expectedGraph !== "unavailable",
    n: measured.length,
    inWindow: 0,
    outOfWindow: 0,
    outOfWindowRate: null,
    cacheOrigin: 0,
    notReadyAtStart: 0,
    stampMismatch: 0,
    boundaryDisagreement: emptyDisagreement(),
    qualityHold: false,
  };
  for (const row of measured) {
    if (!row.seeded || !row.graphEnabled)
      invalid.push(
        `${row.variantKey}#${row.repeat} is not a seeded Graph query`,
      );
    if (row.d2aMode !== fixedGraphMode)
      invalid.push(
        `${row.variantKey}#${row.repeat} ran in ${row.d2aMode}, not the fixed ${fixedGraphMode}`,
      );
    if (entry.inPool && row.snapshot?.usable !== true)
      invalid.push(
        `${row.variantKey}#${row.repeat} started without a usable snapshot (steady-state setup defect)`,
      );
    const join = classifyJoin(row);
    if (join.disagreement) entry.boundaryDisagreement[join.disagreement] += 1;
    if (steadyStateInWindow(row)) entry.inWindow += 1;
    if (row.graph.source === "cache") entry.cacheOrigin += 1;
    if (row.startSlot?.readyFresh !== true) entry.notReadyAtStart += 1;
    if (row.freshnessStamp?.matched !== true) entry.stampMismatch += 1;
  }
  if (entry.n !== MEASURED_RUNS_PER_ARM)
    invalid.push(
      `${variant.key} has ${entry.n} measured Graph samples, not ${MEASURED_RUNS_PER_ARM}`,
    );
  entry.outOfWindow = entry.n - entry.inWindow;
  entry.outOfWindowRate = ratio(entry.outOfWindow, entry.n);
  entry.qualityHold = entry.inPool && entry.inWindow === 0;
  return { entry, invalid };
}

/**
 * (a): steady-state out-of-window rate over the pool of every measured
 * R+IR+Graph sample of the planned variants not expected unavailable (K6/2
 * (a), steps 1, 3, 5, 7, 8). The plan's full AB/BA schedule must be present;
 * a frozen plan is always all 13 variants. Case rates are disclosed, never
 * chosen instead of the pool. A case with no in-window sample is HOLD.
 */
export function summarizeSteadyState(input) {
  rejectOverrides(input, ["samples", "fixedGraphMode", "plan"]);
  const { samples, fixedGraphMode } = input;
  const plan = resolvePlan(input.plan);
  validateGraphCaseSchedule(
    samples,
    plan.variants.map((row) => row.key),
  );
  const { requeries } = separateRequeries(
    samples.filter((row) => row.arm === "graph"),
  );
  const invalid = [];
  const cases = plan.variants.map((variant) => {
    const result = summarizeSteadyStateCase({
      rows: samples,
      variant,
      fixedGraphMode,
    });
    invalid.push(...result.invalid);
    return result.entry;
  });
  const pooled = cases.filter((row) => row.inPool);
  const n = pooled.reduce((sum, row) => sum + row.n, 0);
  const inWindow = pooled.reduce((sum, row) => sum + row.inWindow, 0);
  const outOfWindow = n - inWindow;
  const boundaryDisagreement = emptyDisagreement();
  for (const row of cases)
    for (const [name, count] of Object.entries(row.boundaryDisagreement))
      boundaryDisagreement[name] += count;
  return {
    status: invalid.length === 0 ? "valid" : "invalid",
    invalid,
    planKind: plan.kind,
    pool: {
      n,
      inWindow,
      outOfWindow,
      outOfWindowRate: ratio(outOfWindow, n),
      exceeds: exceedsYardstick(outOfWindow, n),
    },
    cases,
    boundaryDisagreement,
    qualityHoldVariants: cases
      .filter((row) => row.qualityHold)
      .map((row) => row.variantKey),
    requeryCount: requeries.length,
    requeries,
  };
}

/**
 * The single lapse kind of one counted query (rule 3; each query counted
 * once, in the order (i) B seal, (i) Chronicle stop, (ii), (iii), (iv)).
 */
export function lapseKind(query, inWindow) {
  if (
    query.snapshot.usable !== true ||
    query.graph.reason === "registration-unavailable"
  )
    return "i-b-seal";
  if (query.irOutcome === "index-unavailable") return "i-chronicle-stop";
  if (query.a3AtStart.eligible !== true) return "ii-a3-ineligible-at-start";
  if (
    query.graph.revalidation === "invalidated" ||
    query.graph.reason === "invalidated"
  )
    return "iii-invalidated";
  if (inWindow && query.graph.edgeCount === 0) return "iv-empty-contribution";
  return null;
}

/**
 * Rule 4 overlap: the stamp attempt against every record read of the trace
 * (any sample, including re-queries). A missing time anywhere makes the
 * overlap undecidable.
 */
function busyOverlap(query, allQueries) {
  const attempted = query.freshnessStamp?.attemptedAt;
  if (!finite(attempted)) return "overlap-record-missing";
  for (const row of allQueries)
    if (
      !finite(row.recordRead?.startedAt) ||
      !finite(row.recordRead?.finishedAt)
    )
      return "overlap-record-missing";
  return allQueries.some(
    (row) =>
      row.recordRead.startedAt <= attempted &&
      attempted <= row.recordRead.finishedAt,
  )
    ? "overlapped"
    : "clear";
}

/**
 * Rule 4: lapse, then other, then freshness. Returns the category and the
 * reason name used for it. `setup-defect` reasons invalidate the run.
 */
export function outOfWindowCategory(query, allQueries, join) {
  const kind = lapseKind(query, false);
  if (kind && kind !== "iv-empty-contribution")
    return { category: "lapse", reason: kind };
  if (join?.disagreement === BOUNDARY_DISAGREEMENTS.joinedLateWithinTolerance)
    return { category: "other", reason: "boundary-disagreement:joined-late" };
  const graph = query.graph;
  const reason = graph.outcome === "graph-late" ? "graph-late" : graph.reason;
  if (SETUP_DEFECT_REASONS.has(reason))
    return { category: "setup-defect", reason };
  if (FRESHNESS_REASONS.has(reason)) return { category: "freshness", reason };
  if (reason === "busy") {
    if (graph.busyCause !== FRESHNESS_STAMP_BUSY)
      return { category: "other", reason: `busy:${graph.busyCause ?? "none"}` };
    const overlap = busyOverlap(query, allQueries);
    return overlap === "clear"
      ? { category: "freshness", reason: "busy:freshness-stamp" }
      : { category: "other", reason: `busy:freshness-stamp:${overlap}` };
  }
  if (reason === "graph-late") {
    const fresh =
      query.startSlot?.readyFresh === true &&
      query.freshnessStamp?.matched === true;
    const stale =
      query.startSlot?.readyFresh === false ||
      query.freshnessStamp?.matched === false;
    if (fresh) return { category: "other", reason: "graph-late:fresh-start" };
    if (stale)
      return { category: "freshness", reason: "graph-late:stale-start" };
    return { category: "other", reason: "graph-late:start-record-missing" };
  }
  return { category: "other", reason: reason ?? "reason-missing" };
}

/** Rule 5: a category is the main reason only with a strict majority. */
export function mainReason(categories, outOfWindow) {
  if (outOfWindow === 0) return null;
  for (const name of ["lapse", "other", "freshness"])
    if ((categories[name] ?? 0) * 2 > outOfWindow) return name;
  return "none";
}

function invalidTrace(trace, invalid, Q, requeries) {
  return {
    kind: trace.kind,
    status: "invalid",
    invalid,
    Q,
    requeryCount: requeries.length,
  };
}

/**
 * (b) for one trace (rules 1-8). The trace is invalid (retake it, keep the
 * record) when Q < 200, a counted query lacks its expected materials or
 * records, a joined query lacks its edge count, a query is not a seeded
 * Graph query in the fixed mode, or a setup-defect reason appears.
 */
export function summarizeTrace(input) {
  rejectOverrides(input, ["trace", "fixedGraphMode"]);
  const { trace, fixedGraphMode } = input;
  if (trace?.kind !== "editing" && trace?.kind !== "browsing")
    throw new Error("[artifact] trace kind must be editing or browsing");
  const { counted, requeries } = separateRequeries(trace.queries);
  const invalid = [];
  for (const query of counted) {
    if (!query.seeded || !query.graphEnabled)
      invalid.push(`${query.queryId} is not a seeded Graph query`);
    if (query.d2aMode !== fixedGraphMode)
      invalid.push(`${query.queryId} ran in ${query.d2aMode}`);
    if (
      !Array.isArray(query.expectedMaterials) ||
      !query.expectedMaterials.length
    )
      invalid.push(`${query.queryId} lacks expected contribution materials`);
    if (typeof query.snapshot?.usable !== "boolean")
      invalid.push(`${query.queryId} lacks the snapshot record`);
    if (typeof query.a3AtStart?.eligible !== "boolean")
      invalid.push(`${query.queryId} lacks the start-time A3 record`);
    if (
      query.graph?.joined === true &&
      !(Number.isInteger(query.graph.edgeCount) && query.graph.edgeCount >= 0)
    )
      invalid.push(
        `${query.queryId} joined a Graph result without its edge count`,
      );
  }
  const Q = counted.length;
  if (Q < TRACE_MIN_QUERIES)
    invalid.push(`trace has Q=${Q}, fewer than ${TRACE_MIN_QUERIES}`);
  if (invalid.length > 0) return invalidTrace(trace, invalid, Q, requeries);
  const usable = counted.filter((query) => query.snapshot.usable === true);
  const lapses = {
    "i-b-seal": 0,
    "i-chronicle-stop": 0,
    "ii-a3-ineligible-at-start": 0,
    "iii-invalidated": 0,
    "iv-empty-contribution": 0,
  };
  const categories = { lapse: 0, other: 0, freshness: 0 };
  const reasons = {};
  const boundaryDisagreement = emptyDisagreement();
  let inWindow = 0;
  let overlapped = 0;
  let overlapMissing = 0;
  let freshnessStampBusy = 0;
  for (const query of counted) {
    const join = classifyJoin(query);
    if (join.disagreement) boundaryDisagreement[join.disagreement] += 1;
    // Rule 2: only a query of U can be in-window.
    const inside = join.inWindow && query.snapshot.usable === true;
    if (inside) inWindow += 1;
    const kind = lapseKind(query, inside);
    if (kind) lapses[kind] += 1;
    if (inside) continue;
    const { category, reason } = outOfWindowCategory(
      query,
      trace.queries,
      join,
    );
    if (category === "setup-defect")
      invalid.push(`${query.queryId} reported ${reason} (setup defect)`);
    else categories[category] += 1;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (reason === "busy:freshness-stamp") freshnessStampBusy += 1;
    if (reason === "busy:freshness-stamp:overlapped") overlapped += 1;
    if (reason === "busy:freshness-stamp:overlap-record-missing")
      overlapMissing += 1;
  }
  if (invalid.length > 0) return invalidTrace(trace, invalid, Q, requeries);
  const U = usable.length;
  const outOfWindowU = U - inWindow;
  const outOfWindow = Q - inWindow;
  const lapseTotal = Object.values(lapses).reduce((sum, n) => sum + n, 0);
  return {
    kind: trace.kind,
    status: "valid",
    invalid: [],
    Q,
    U,
    inWindow,
    outOfWindow,
    outOfWindowRate: ratio(outOfWindowU, U),
    outOfWindowExceeds: exceedsYardstick(outOfWindowU, U),
    lapse: { total: lapseTotal, ...lapses },
    lapseRate: ratio(lapseTotal, Q),
    lapseExceeds: exceedsYardstick(lapseTotal, Q),
    categories,
    reasons,
    boundaryDisagreement,
    busy: {
      freshnessStamp: freshnessStampBusy,
      overlapped,
      overlapRecordMissing: overlapMissing,
      causes: countBy(
        counted.filter((query) => query.graph.reason === "busy"),
        (query) => query.graph.busyCause,
      ),
    },
    sources: countBy(
      counted.filter((query) => query.graph.joined),
      (query) => query.graph.source,
    ),
    outcomes: countBy(counted, (query) => query.graph.outcome),
    a3IneligibleAtStart: counted.filter((query) => !query.a3AtStart.eligible)
      .length,
    emptyContribution: lapses["iv-empty-contribution"],
    mainReason: mainReason(categories, outOfWindow),
    requeryCount: requeries.length,
  };
}

/**
 * K6/2 step 4 density for the recorded event stream of a trace run. Editing:
 * product-editor edit -> autosave commit (version increased) -> the product's
 * own query, with no harness wait or operation between the commit and the
 * query, a commit before every query after the first, and no approval.
 * Browsing: no edit, no commit, no approval.
 */
export function validateTraceEvents(kind, events) {
  const errors = [];
  let sinceLastQuery = [];
  let queries = 0;
  for (const event of events) {
    if (event.type === "approval")
      errors.push("a trace must not contain an approval operation");
    if (event.type === "query") {
      if (event.trigger !== USER_OPERATION) continue;
      if (event.issuedBy !== "product")
        errors.push(`query ${queries} was not issued by the product`);
      if (kind === "editing" && queries > 0) {
        const commits = sinceLastQuery.filter(
          (row) => row.type === "autosave-commit",
        );
        if (commits.length === 0)
          errors.push(`query ${queries} has no autosave commit before it`);
        const lastCommit = sinceLastQuery.findLastIndex(
          (row) => row.type === "autosave-commit",
        );
        const editAt = sinceLastQuery.findIndex((row) => row.type === "edit");
        if (editAt < 0 || (lastCommit >= 0 && editAt > lastCommit))
          errors.push(`query ${queries} lacks an edit before its commit`);
        if (
          sinceLastQuery
            .slice(lastCommit + 1)
            .some((row) => row.type.startsWith("harness-"))
        )
          errors.push(
            `query ${queries} has a harness wait or operation after its commit`,
          );
      }
      queries += 1;
      sinceLastQuery = [];
      continue;
    }
    if (event.type === "edit" && event.via !== "product-editor")
      errors.push("edits must go through the product editor");
    if (
      event.type === "autosave-commit" &&
      !(event.versionAfter > event.versionBefore)
    )
      errors.push("an autosave commit must increase the Scene version");
    if (
      kind === "browsing" &&
      (event.type === "edit" || event.type === "autosave-commit")
    )
      errors.push("a browsing trace must not edit or save");
    sinceLastQuery.push(event);
  }
  return { queries, errors };
}

/**
 * CP-4 availability (TASK §15.4, K6/2 "条件が成立しない場合の CP-4 の可用性").
 * (a) above the yardstick is HOLD and the trace values are recorded and
 * disclosed only. (a) inside with a trace above it is HOLD and asks for the
 * (iii) diagnostic. This function never raises `[precheck]`.
 */
export function decideCp4Availability(input) {
  rejectOverrides(input, ["steadyState", "traces"]);
  const { steadyState, traces } = input;
  const disclose = {
    steadyState: steadyState?.pool ?? null,
    boundaryDisagreement: steadyState?.boundaryDisagreement ?? null,
    traces: (traces ?? []).map((trace) => ({
      kind: trace.kind,
      status: trace.status,
      outOfWindowRate: trace.outOfWindowRate ?? null,
      lapseRate: trace.lapseRate ?? null,
      boundaryDisagreement: trace.boundaryDisagreement ?? null,
    })),
  };
  if (steadyState?.status !== "valid")
    return { verdict: "invalid", reason: "steady-state-run-invalid", disclose };
  if (steadyState.planKind !== "frozen")
    return {
      verdict: "preview-only",
      reason: "dev-plan-is-never-a-cp4-result",
      disclose,
    };
  if (steadyState.pool.exceeds)
    return {
      verdict: "HOLD",
      reason: "steady-state-out-of-window-rate-exceeds",
      traceValues: "recorded-and-disclosed-only",
      iiiDiagnosticRequired: false,
      disclose,
    };
  if (!traces || traces.length === 0)
    return {
      verdict: "HOLD",
      reason: "traces-not-measured",
      iiiDiagnosticRequired: false,
      disclose,
    };
  for (const required of ["editing", "browsing"])
    if (!traces.some((trace) => trace.kind === required))
      return {
        verdict: "HOLD",
        reason: `${required}-trace-not-measured`,
        iiiDiagnosticRequired: false,
        disclose,
      };
  if (traces.some((trace) => trace.status !== "valid"))
    return {
      verdict: "HOLD",
      reason: "trace-defect-retake",
      iiiDiagnosticRequired: false,
      disclose,
    };
  if (traces.some((trace) => trace.outOfWindowExceeds || trace.lapseExceeds))
    return {
      verdict: "HOLD",
      reason: "trace-exceeds-yardstick",
      iiiDiagnosticRequired: true,
      disclose,
    };
  return {
    verdict: "no-yardstick-trigger",
    reason: "judge-by-post-B-216-and-disclose-three-values",
    iiiDiagnosticRequired: false,
    disclose,
  };
}

/**
 * Rule 6 for a condition-judging diagnostic ((i), (ii) or (iii)). Only here
 * can a trace's lapse rate raise `[precheck]`. (iii) must reuse the trace
 * file fixed before CP-4's observation.
 */
export function evaluateDiagnosticCondition(input) {
  rejectOverrides(input, [
    "kind",
    "steadyState",
    "traces",
    "traceFile",
    "cp4TraceFile",
  ]);
  const { kind, steadyState, traces, traceFile, cp4TraceFile = null } = input;
  if (!["i", "ii", "iii"].includes(kind))
    throw new Error(`[precheck] unknown diagnostic kind ${kind}`);
  if (kind === "iii") {
    if (
      !cp4TraceFile ||
      traceFile?.commit !== cp4TraceFile.commit ||
      traceFile?.sha256 !== cp4TraceFile.sha256
    )
      throw new Error(
        "[precheck] the (iii) diagnostic must reuse the trace file fixed before CP-4's observation",
      );
  }
  if (
    steadyState?.status !== "valid" ||
    traces.some((t) => t.status !== "valid")
  )
    return { result: "invalid-retake" };
  if (steadyState.pool.exceeds)
    return { result: "row-not-used", reason: "steady-state-exceeds-hold" };
  const lapsing = traces.filter((trace) => trace.lapseExceeds);
  if (lapsing.length > 0)
    return {
      result: "precheck",
      reason: "lapse-rate-exceeds",
      traces: lapsing.map((trace) => ({
        kind: trace.kind,
        lapseRate: trace.lapseRate,
        indexRebuildWait:
          trace.lapse["i-b-seal"] + trace.lapse["i-chronicle-stop"],
        approvalLapse:
          trace.lapse["ii-a3-ineligible-at-start"] +
          trace.lapse["iii-invalidated"] +
          trace.lapse["iv-empty-contribution"],
        byKind: { ...trace.lapse },
      })),
    };
  const exceeding = traces.filter((trace) => trace.outOfWindowExceeds);
  if (exceeding.length === 0)
    return { result: "condition-not-met", reason: "b-does-not-hold" };
  const mains = exceeding.map((trace) => trace.mainReason);
  if (mains.some((main) => main === "lapse" || main === "none"))
    return { result: "precheck", reason: "main-reason-lapse-or-none", mains };
  if (mains.some((main) => main === "other"))
    return { result: "row-not-used", reason: "main-reason-other", mains };
  return { result: "condition-met-confirmation-required", mains };
}
