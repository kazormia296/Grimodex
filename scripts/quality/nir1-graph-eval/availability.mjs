// CP-4 Graph availability: K6/2 `graph-eval-procedure` measurement steps 1-9
// and "(b) の判定の規則" 1-8, applied to recorded samples.
//
// Pure module: it classifies samples that a harness already recorded and
// never observes a runtime. Every rule is the frozen K6/2 text; D, the lease,
// the 1% yardstick and the run counts come from constants.mjs only.
//
// Sample record (one Related Scenes query of one arm):
//   variantKey, arm ("hybrid" | "graph"), phase ("warmup" | "measured"),
//   repeat, trigger ("user-operation" | "graph-ready-requery" |
//   "index-ready-requery"), seeded, graphEnabled, d2aMode,
//   tFetch, tRawReady, tReturn            monotonic ms
//   snapshot: { usable, reason }          B seal current at start
//   irOutcome                             same query's IR outcome
//   a3AtStart: { eligible, reasons }      expected materials at start
//   startSlot: { readyFresh }             owner slot was a new READY
//   freshnessStamp: { matched, attemptedAt }
//   recordRead: { startedAt, finishedAt } read-only record connection
//   graph: { outcome, reason, source, joined, arrivedAt, revalidation,
//            edgeCount, busyCause }
//   finalSceneIds                         the returned final list
//   expectedMaterials                     trace queries only

import {
  GRAPH_CASE_ARMS,
  GRAPH_EVAL_D_MS,
  GRAPH_EVAL_VARIANTS,
  MEASURED_RUNS_PER_ARM,
  TRACE_MIN_QUERIES,
  WARMUP_RUNS_PER_ARM,
  exceedsYardstick,
  ratio,
  rejectOverrides,
  variantByKey,
} from "./constants.mjs";

const USER_OPERATION = "user-operation";
const SETUP_DEFECT_REASONS = new Set([
  "not-requested",
  "not-activated",
  "profile-not-restricted",
]);
const FRESHNESS_REASONS = new Set(["stale", "warming"]);
const FRESHNESS_STAMP_BUSY = "freshness-stamp-read-failed";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether the product joined this sample's Graph result into the final
 * result within `t_raw_ready + D` (K6/2 step 5, inclusive). A joined result
 * that failed revalidation or arrived after the window is a mixed late
 * result and is refused (N-7) instead of being counted.
 */
export function joinedWithinWindow(sample) {
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
  if (!graph.joined) return false;
  if (graph.revalidation !== "passed")
    throw new Error(
      "[artifact] a Graph result that did not pass return-time revalidation was joined",
    );
  if (!finite(graph.arrivedAt))
    throw new Error("[artifact] joined Graph result lacks its arrival time");
  if (graph.arrivedAt > sample.tRawReady + GRAPH_EVAL_D_MS)
    throw new Error(
      "[artifact] a late Graph result was mixed into its query (N-7)",
    );
  return true;
}

/** (a): only a worker result of this query's ticket counts as in-window. */
export function steadyStateInWindow(sample) {
  const joined = joinedWithinWindow(sample);
  return joined && sample.graph.source === "worker";
}

/** The predeclared AB/BA order for one variant (K6/2 step 2, P schedule). */
export function graphCaseScheduleKeys(variantKey) {
  variantByKey(variantKey);
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

/**
 * (a): steady-state out-of-window rate over the pool of every measured
 * R+IR+Graph sample of the variants not expected unavailable (K6/2 (a),
 * steps 1, 3, 5, 7, 8). Case rates are disclosed, never chosen instead of the
 * pool. A case with no in-window sample is quality HOLD.
 */
export function summarizeSteadyState(input) {
  rejectOverrides(input, ["samples", "fixedGraphMode"]);
  const { samples, fixedGraphMode } = input;
  const graphRows = samples.filter((row) => row.arm === "graph");
  const { counted, requeries } = separateRequeries(graphRows);
  const measured = counted.filter((row) => row.phase === "measured");
  const invalid = [];
  const perVariant = new Map();
  for (const row of measured) {
    const variant = variantByKey(row.variantKey);
    if (!row.seeded || !row.graphEnabled)
      invalid.push(
        `${row.variantKey}#${row.repeat} is not a seeded Graph query`,
      );
    if (row.d2aMode !== fixedGraphMode)
      invalid.push(
        `${row.variantKey}#${row.repeat} ran in ${row.d2aMode}, not the fixed ${fixedGraphMode}`,
      );
    if (
      variant.expectedGraph !== "unavailable" &&
      row.snapshot?.usable !== true
    )
      invalid.push(
        `${row.variantKey}#${row.repeat} started without a usable snapshot (steady-state setup defect)`,
      );
    const entry = perVariant.get(variant.key) ?? {
      variant,
      n: 0,
      inWindow: 0,
      cacheOrigin: 0,
      notReadyAtStart: 0,
      stampMismatch: 0,
    };
    entry.n += 1;
    if (steadyStateInWindow(row)) entry.inWindow += 1;
    if (row.graph.source === "cache") entry.cacheOrigin += 1;
    if (row.startSlot?.readyFresh !== true) entry.notReadyAtStart += 1;
    if (row.freshnessStamp?.matched !== true) entry.stampMismatch += 1;
    perVariant.set(variant.key, entry);
  }
  for (const entry of perVariant.values())
    if (entry.n !== MEASURED_RUNS_PER_ARM)
      invalid.push(
        `${entry.variant.key} has ${entry.n} measured Graph samples, not ${MEASURED_RUNS_PER_ARM}`,
      );
  const pooled = [...perVariant.values()].filter(
    (entry) => entry.variant.expectedGraph !== "unavailable",
  );
  const n = pooled.reduce((sum, entry) => sum + entry.n, 0);
  const inWindow = pooled.reduce((sum, entry) => sum + entry.inWindow, 0);
  const outOfWindow = n - inWindow;
  const cases = [...perVariant.values()].map((entry) => ({
    variantKey: entry.variant.key,
    inPool: entry.variant.expectedGraph !== "unavailable",
    n: entry.n,
    inWindow: entry.inWindow,
    outOfWindow: entry.n - entry.inWindow,
    outOfWindowRate: ratio(entry.n - entry.inWindow, entry.n),
    cacheOrigin: entry.cacheOrigin,
    notReadyAtStart: entry.notReadyAtStart,
    stampMismatch: entry.stampMismatch,
    qualityHold:
      entry.variant.expectedGraph !== "unavailable" && entry.inWindow === 0,
  }));
  return {
    status: invalid.length === 0 ? "valid" : "invalid",
    invalid,
    pool: {
      n,
      inWindow,
      outOfWindow,
      outOfWindowRate: ratio(outOfWindow, n),
      exceeds: exceedsYardstick(outOfWindow, n),
    },
    cases,
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

function busyOverlap(query, counted) {
  const attempted = query.freshnessStamp?.attemptedAt;
  if (!finite(attempted)) return "overlap-record-missing";
  for (const row of counted)
    if (
      !finite(row.recordRead?.startedAt) ||
      !finite(row.recordRead?.finishedAt)
    )
      return "overlap-record-missing";
  return counted.some(
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
export function outOfWindowCategory(query, counted) {
  const kind = lapseKind(query, false);
  if (kind && kind !== "iv-empty-contribution")
    return { category: "lapse", reason: kind };
  const graph = query.graph;
  const reason = graph.outcome === "graph-late" ? "graph-late" : graph.reason;
  if (SETUP_DEFECT_REASONS.has(reason))
    return { category: "setup-defect", reason };
  if (FRESHNESS_REASONS.has(reason)) return { category: "freshness", reason };
  if (reason === "busy") {
    if (graph.busyCause !== FRESHNESS_STAMP_BUSY)
      return { category: "other", reason: `busy:${graph.busyCause ?? "none"}` };
    const overlap = busyOverlap(query, counted);
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

/**
 * (b) for one trace (rules 1-8). The trace is invalid (retake it, keep the
 * record) when Q < 200, a counted query lacks its expected materials or
 * records, a query is not a seeded Graph query in the fixed mode, or a
 * setup-defect reason appears.
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
  }
  const Q = counted.length;
  if (Q < TRACE_MIN_QUERIES)
    invalid.push(`trace has Q=${Q}, fewer than ${TRACE_MIN_QUERIES}`);
  if (invalid.length > 0)
    return {
      kind: trace.kind,
      status: "invalid",
      invalid,
      Q,
      requeryCount: requeries.length,
    };
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
  let inWindow = 0;
  let overlapped = 0;
  let overlapMissing = 0;
  let freshnessStampBusy = 0;
  for (const query of counted) {
    // Rule 2: only a query of U can be in-window; joinedWithinWindow still
    // refuses a mixed late result on every counted query.
    const joined = joinedWithinWindow(query) && query.snapshot.usable === true;
    if (joined) inWindow += 1;
    const kind = lapseKind(query, joined);
    if (kind) lapses[kind] += 1;
    if (joined) continue;
    const { category, reason } = outOfWindowCategory(query, counted);
    if (category === "setup-defect")
      invalid.push(`${query.queryId} reported ${reason} (setup defect)`);
    else categories[category] += 1;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (reason === "busy:freshness-stamp") freshnessStampBusy += 1;
    if (reason === "busy:freshness-stamp:overlapped") overlapped += 1;
    if (reason === "busy:freshness-stamp:overlap-record-missing")
      overlapMissing += 1;
  }
  if (invalid.length > 0)
    return {
      kind: trace.kind,
      status: "invalid",
      invalid,
      Q,
      requeryCount: requeries.length,
    };
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
export function decideCp4Availability({ steadyState, traces }) {
  const disclose = {
    steadyState: steadyState?.pool ?? null,
    traces: (traces ?? []).map((trace) => ({
      kind: trace.kind,
      status: trace.status,
      outOfWindowRate: trace.outOfWindowRate ?? null,
      lapseRate: trace.lapseRate ?? null,
    })),
  };
  if (steadyState?.status !== "valid")
    return { verdict: "invalid", reason: "steady-state-run-invalid", disclose };
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
export function evaluateDiagnosticCondition({
  kind,
  steadyState,
  traces,
  traceFile,
  cp4TraceFile = null,
}) {
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

export const ALL_VARIANT_KEYS = Object.freeze(
  GRAPH_EVAL_VARIANTS.map((row) => row.key),
);
