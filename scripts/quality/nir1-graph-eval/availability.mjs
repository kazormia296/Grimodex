// CP-4 Graph availability: K6/2 `graph-eval-procedure` measurement steps 1-9
// and "(b) の判定の規則" 1-8, read through K6/4 (`nir1-final-request-eval-
// proposal/4`, confirmed 2026-10-26) when the candidate qualifies (批准 5):
// (a) becomes the display availability miss rate (first render in the D
// window or a follow-up success, followup.mjs) and (b) counts follow-ups
// (変える点 1〜3, 15). The first-render out-of-window rate is still computed
// and disclosed. A candidate without the 批准 5 evidence, or whose records
// break 批准 12 / (b-3), stays on the K6/2 text (変える点 12, N30, N31).
//
// Pure module: it classifies samples that a harness already recorded and
// never observes a runtime. D, W_f, T_late, T_show, the lease, the 1%
// yardstick, the boundary tolerance and the run counts come from
// constants.mjs only.
//
// Sample record (one Related Scenes query of one arm):
//   variantKey, arm ("hybrid" | "graph"), phase ("warmup" | "measured"),
//   repeat, trigger ("user-operation" | "graph-ready-requery" |
//   "index-ready-requery"), seeded, graphEnabled, d2aMode,
//   tFetch, tRawReady, tReturn            renderer performance.now() ms
//   snapshot: { usable, reason }          B seal current at start (the
//                                         Chronicle Index is not part of it)
//   irOutcome                             same query's IR outcome
//                                         ("index-unavailable" = Chronicle
//                                         stopped at the start)
//   followUp                              K6/4 R7 record (followup.mjs)
//   a3AtStart: { eligible, reasons }      expected materials at start
//   startSlot: { readyFresh }             owner slot was a new READY
//   freshnessStamp: { result, matched, attemptedAtNs }
//   recordRead: { startedAtNs, finishedAtNs } read-only record connection
//                                         (*Ns: the evaluation Native clock,
//                                         native-sample.mjs; never mixed with
//                                         the renderer ms of the window)
//   graph: { outcome, reason, source, joined, arrivedAt, revalidation,
//            edgeCount, busyCause }       arrivedAt: the same renderer clock
//                                         the product's join helper compared
//   finalSceneIds                         the returned final list
//   expectedMaterials                     trace queries only

import { isNativeNs } from "./native-sample.mjs";
import {
  AVAILABILITY_YARDSTICK,
  GRAPH_CASE_ARMS,
  MEASURED_RUNS_PER_ARM,
  TRACE_MIN_QUERIES,
  WARMUP_RUNS_PER_ARM,
  exceedsYardstick,
  ratio,
  rejectOverrides,
  resolvePlan,
} from "./constants.mjs";
import {
  PRODUCT_HOOK,
  assessCandidateRegime,
  classifyFollowUp,
  followUpFailureCategory,
  followUpLapseQuestions,
  recordRegime,
} from "./followup.mjs";
import {
  BOUNDARY_DISAGREEMENTS,
  FRESHNESS_REASONS,
  SETUP_DEFECT_REASONS,
  STAMP_WITHOUT_COMPARISON,
  USER_OPERATION,
  assertNoRetiredBusy,
  classifyJoin,
  lapseKind,
  steadyStateInWindow,
} from "./join.mjs";
import { distribution } from "./stats.mjs";

export {
  BOUNDARY_DISAGREEMENTS,
  classifyJoin,
  joinedWithinWindow,
  lapseKind,
  steadyStateInWindow,
} from "./join.mjs";

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

const X_CODES = Object.freeze([
  "F1",
  "F6",
  "X1",
  "X2",
  "X3",
  "X4",
  "X5",
  "X6",
  "X7",
  "X8",
  "X9",
  "X10",
  "X11",
  "X12",
  "X13",
]);

function emptyX() {
  return Object.fromEntries(X_CODES.map((code) => [code, 0]));
}

/**
 * K6/4 display availability of one case (「設計」表示の可用性 :165-167): each
 * measured R+IR+Graph sample is first render, follow-up or not displayed.
 * The X counts are a breakdown in which one sample may appear under several
 * codes (DR-CP4-K64-4); `missed` counts each sample once.
 */
function k64CaseBlock(measured) {
  const block = {
    n: measured.length,
    firstRender: 0,
    followUp: 0,
    displayed: 0,
    missed: 0,
    x: emptyX(),
    violations: [],
    notApplied: [],
    q1: [],
    q2: [],
    q3: [],
  };
  for (const row of measured) {
    const result = classifyFollowUp(row, { context: "steady" });
    if (result.firstRender) block.firstRender += 1;
    else if (result.followUp) block.followUp += 1;
    if (result.displayed) block.displayed += 1;
    else {
      block.missed += 1;
      for (const code of Object.keys(result.x)) block.x[code] += 1;
    }
    for (const code of result.violations)
      block.violations.push({
        variantKey: row.variantKey,
        repeat: row.repeat,
        code,
      });
    for (const issue of result.ratification12)
      block.notApplied.push(`ratification-12:${issue}`);
    if (result.loadingSwitched)
      block.notApplied.push("b-3:loading-on-graph-ready");
    for (const name of ["q1", "q2", "q3"])
      if (result.q[name] !== null) block[name].push(result.q[name]);
  }
  block.notApplied = [...new Set(block.notApplied)];
  return block;
}

/**
 * The (a) record of one variant from its measured R+IR+Graph samples.
 * Returns the case entry and the reasons that invalidate the run. With
 * `candidate` (a K6/4-era run; the value is the 批准 5 evidence) the entry
 * also carries the K6/4 display block, and every measured Graph sample must
 * come from the product hook consumer (R5, N16).
 */
export function summarizeSteadyStateCase(input) {
  rejectOverrides(input, ["rows", "variant", "fixedGraphMode", "candidate"]);
  const { rows, variant, fixedGraphMode } = input;
  const k64Era = Object.hasOwn(input, "candidate");
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
    stampWithoutComparison: 0,
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
    if (k64Era && row.followUp?.issuedVia !== PRODUCT_HOOK)
      invalid.push(
        `N16: ${row.variantKey}#${row.repeat} was not issued through the product hook consumer (R5)`,
      );
    assertNoRetiredBusy(row);
    const join = classifyJoin(row);
    if (join.disagreement) entry.boundaryDisagreement[join.disagreement] += 1;
    if (steadyStateInWindow(row)) entry.inWindow += 1;
    if (row.graph.source === "cache") entry.cacheOrigin += 1;
    if (row.startSlot?.readyFresh !== true) entry.notReadyAtStart += 1;
    if (row.freshnessStamp?.matched !== true) entry.stampMismatch += 1;
    if (STAMP_WITHOUT_COMPARISON.has(row.freshnessStamp?.result))
      entry.stampWithoutComparison += 1;
  }
  if (entry.n !== MEASURED_RUNS_PER_ARM)
    invalid.push(
      `${variant.key} has ${entry.n} measured Graph samples, not ${MEASURED_RUNS_PER_ARM}`,
    );
  entry.outOfWindow = entry.n - entry.inWindow;
  entry.outOfWindowRate = ratio(entry.outOfWindow, entry.n);
  entry.qualityHold = entry.inPool && entry.inWindow === 0;
  if (k64Era && entry.inPool && invalid.length === 0) {
    const block = k64CaseBlock(measured);
    entry.k64 = {
      ...block,
      q1: distribution(block.q1),
      q2: distribution(block.q2),
      q3: distribution(block.q3),
      missRate: ratio(block.missed, block.n),
    };
  }
  return { entry, invalid };
}

/**
 * Steady state over the pool of every measured R+IR+Graph sample of the
 * planned variants not expected unavailable (K6/2 (a), steps 1, 3, 5, 7, 8).
 * The plan's full AB/BA schedule must be present; a frozen plan is always
 * all 13 variants. Case rates are disclosed, never chosen instead of the
 * pool.
 *
 * Without `candidate` this is K6/2 (`regime: "k62"`): (a) is the first-render
 * out-of-window rate and a case with no in-window sample is HOLD. With
 * `candidate` (the 批准 5 evidence) the regime is K6/4 when the candidate and
 * its records qualify (followup.mjs `recordRegime`): (a) is the display
 * miss rate over the pool (1%: floor(0.01 × n) misses allowed), a case with
 * no displayed sample or an empty pool is HOLD, the first-render rate is
 * disclosed (N18), and a late result mixed into a display is a violation
 * (FAIL, :163).
 */
export function summarizeSteadyState(input) {
  rejectOverrides(input, ["samples", "fixedGraphMode", "plan", "candidate"]);
  const { samples, fixedGraphMode } = input;
  const k64Era = Object.hasOwn(input, "candidate");
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
      ...(k64Era ? { candidate: input.candidate } : {}),
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
  const base = {
    status: invalid.length === 0 ? "valid" : "invalid",
    invalid,
    planKind: plan.kind,
    regime: "k62",
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
  if (!k64Era || invalid.length > 0) return base;
  const assessed = assessCandidateRegime(input.candidate);
  const notApplied = [
    ...new Set([
      ...assessed.missing,
      ...pooled.flatMap((row) => row.k64.notApplied),
    ]),
  ];
  if (notApplied.length > 0) return { ...base, k64NotApplied: notApplied };
  const sum = (pick) => pooled.reduce((total, row) => total + pick(row), 0);
  const displayed = sum((row) => row.k64.displayed);
  const missed = n - displayed;
  const x = emptyX();
  for (const row of pooled)
    for (const [code, count] of Object.entries(row.k64.x)) x[code] += count;
  const qualityHoldVariants = pooled
    .filter((row) => row.k64.displayed === 0)
    .map((row) => row.variantKey);
  const pooledSamples = samples.filter(
    (row) =>
      row.arm === "graph" &&
      row.trigger === USER_OPERATION &&
      row.phase === "measured" &&
      pooled.some((entry) => entry.variantKey === row.variantKey),
  );
  const q = { q1: [], q2: [], q3: [] };
  for (const row of pooledSamples) {
    const result = classifyFollowUp(row, { context: "steady" });
    for (const name of ["q1", "q2", "q3"])
      if (result.q[name] !== null) q[name].push(result.q[name]);
  }
  return {
    ...base,
    regime: "k64",
    qualityHoldVariants,
    k64: {
      candidate: assessed,
      display: {
        n,
        firstRender: sum((row) => row.k64.firstRender),
        followUp: sum((row) => row.k64.followUp),
        displayed,
        missed,
        missRate: ratio(missed, n),
        allowedMisses: Math.floor(
          (n * AVAILABILITY_YARDSTICK.numerator) /
            AVAILABILITY_YARDSTICK.denominator,
        ),
        exceeds: exceedsYardstick(missed, n),
      },
      poolEmpty: n === 0,
      holdCases: qualityHoldVariants,
      violations: pooled.flatMap((row) => row.k64.violations),
      x,
      q: {
        q1: distribution(q.q1),
        q2: distribution(q.q2),
        q3: distribution(q.q3),
      },
      firstRenderOutOfWindowRate: base.pool.outOfWindowRate,
    },
  };
}

/**
 * Rule 4 overlap: the stamp attempt against every record read of the trace
 * (any sample, including re-queries). A missing time anywhere makes the
 * overlap undecidable.
 */
function busyOverlap(query, allQueries) {
  // Both sides are evaluation Native ns (native-sample.mjs); nothing here is
  // compared with the renderer ms of the window.
  const attempted = query.freshnessStamp?.attemptedAtNs;
  if (!isNativeNs(attempted)) return "overlap-record-missing";
  for (const row of allQueries)
    if (
      !isNativeNs(row.recordRead?.startedAtNs) ||
      !isNativeNs(row.recordRead?.finishedAtNs)
    )
      return "overlap-record-missing";
  return allQueries.some(
    (row) =>
      row.recordRead.startedAtNs <= attempted &&
      attempted <= row.recordRead.finishedAtNs,
  )
    ? "overlapped"
    : "clear";
}

/**
 * Rule 4: lapse, then other, then freshness. Returns the category and the
 * reason name used for it. `setup-defect` reasons invalidate the run.
 * A stamp attempt without a comparison (the stamp read failed, or the READY
 * stamp was missing) is counted on its own and goes to "other", never to
 * freshness (DR-CP4-S1C1-8); its record-read overlap is still computed for
 * disclosure.
 */
export function outOfWindowCategory(query, allQueries, join) {
  assertNoRetiredBusy(query);
  const kind = lapseKind(query, false);
  if (kind && kind !== "iv-empty-contribution")
    return { category: "lapse", reason: kind };
  if (join?.disagreement === BOUNDARY_DISAGREEMENTS.joinedLateWithinTolerance)
    return { category: "other", reason: "boundary-disagreement:joined-late" };
  const graph = query.graph;
  const reason = graph.outcome === "graph-late" ? "graph-late" : graph.reason;
  if (SETUP_DEFECT_REASONS.has(reason))
    return { category: "setup-defect", reason };
  const stampResult = query.freshnessStamp?.result;
  if (STAMP_WITHOUT_COMPARISON.has(stampResult))
    return {
      category: "other",
      reason: `freshness-stamp-${stampResult}:${busyOverlap(query, allQueries)}`,
    };
  if (FRESHNESS_REASONS.has(reason)) return { category: "freshness", reason };
  if (reason === "busy")
    return { category: "other", reason: `busy:${graph.busyCause ?? "none"}` };
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

function emptyLapses() {
  return {
    "i-b-seal": 0,
    "i-chronicle-stop": 0,
    "ii-a3-ineligible-at-start": 0,
    "iii-invalidated": 0,
    "iv-empty-contribution": 0,
  };
}

function emptyStampWithoutComparison() {
  return {
    unavailable: { clear: 0, overlapped: 0, "overlap-record-missing": 0 },
    "stamp0-missing": { clear: 0, overlapped: 0, "overlap-record-missing": 0 },
  };
}

function countStamp(stampWithoutComparison, reason) {
  const stamp = /^freshness-stamp-(unavailable|stamp0-missing):(.+)$/u.exec(
    reason,
  );
  if (stamp) stampWithoutComparison[stamp[1]][stamp[2]] += 1;
}

/** The (b) values both regimes write (rule 8). */
function traceDisclosure(counted) {
  return {
    busy: {
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
  };
}

/** K6/2 rules 2-5 (the trace of a candidate K6/4 does not apply to). */
function summarizeTraceK62(trace, counted, requeries) {
  const invalid = [];
  const Q = counted.length;
  const usable = counted.filter((query) => query.snapshot.usable === true);
  const lapses = emptyLapses();
  const categories = { lapse: 0, other: 0, freshness: 0 };
  const reasons = {};
  const boundaryDisagreement = emptyDisagreement();
  let inWindow = 0;
  const stampWithoutComparison = emptyStampWithoutComparison();
  for (const query of counted) {
    assertNoRetiredBusy(query);
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
    countStamp(stampWithoutComparison, reason);
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
    regime: "k62",
    Q,
    U,
    inWindow,
    outOfWindow,
    outOfWindowU,
    outOfWindowRate: ratio(outOfWindowU, U),
    outOfWindowExceeds: exceedsYardstick(outOfWindowU, U),
    lapse: { total: lapseTotal, ...lapses },
    lapseRate: ratio(lapseTotal, Q),
    lapseExceeds: exceedsYardstick(lapseTotal, Q),
    categories,
    reasons,
    boundaryDisagreement,
    stampWithoutComparison,
    ...traceDisclosure(counted),
    emptyContribution: lapses["iv-empty-contribution"],
    mainReason: mainReason(categories, outOfWindow),
    requeryCount: requeries.length,
  };
}

/**
 * (b) under K6/4 変える点 15 (K6/4:109): a query of U is displayed when its
 * first render is in the D window (K6/2 rule 2, cache included) or its
 * follow-up succeeds (F1〜F7 without R1, R2; F2 between the parent's and the
 * child's begin). The out-of-window rate is the share of U not displayed.
 * The category of a query not displayed is K6/2 rule 4 first and then the
 * stage where its follow-up failed; the D′ structural graph-late is never a
 * reason (N33). The lapse rate (K6/2 717 (i)〜(iv)) is unchanged; a trace in
 * which a follow-up failed on a lapse-like stage stops with `[precheck]`
 * because K6/4 does not say whether those count (DR-CP4-K64-5).
 */
function summarizeTraceK64(trace, counted, requeries, results, regime) {
  const invalid = [];
  const Q = counted.length;
  const lapses = emptyLapses();
  const categories = { lapse: 0, other: 0, freshness: 0 };
  const reasons = {};
  const boundaryDisagreement = emptyDisagreement();
  const stampWithoutComparison = emptyStampWithoutComparison();
  const x = emptyX();
  const lapseQuestions = {};
  let U = 0;
  let displayed = 0;
  let firstRenderInWindow = 0;
  let followUpDisplayed = 0;
  const q = { q1: [], q2: [], q3: [] };
  counted.forEach((query, at) => {
    const result = results[at];
    if (result.boundary) boundaryDisagreement[result.boundary] += 1;
    const usable = query.snapshot.usable === true;
    if (usable) U += 1;
    const shown = usable && result.displayed;
    if (result.firstRender) firstRenderInWindow += 1;
    if (shown) {
      displayed += 1;
      if (!result.firstRender) followUpDisplayed += 1;
    }
    for (const name of ["q1", "q2", "q3"])
      if (result.q[name] !== null) q[name].push(result.q[name]);
    const kind = lapseKind(query, result.firstRender);
    if (kind) lapses[kind] += 1;
    if (shown) return;
    for (const code of Object.keys(result.x)) x[code] += 1;
    for (const question of followUpLapseQuestions(result))
      lapseQuestions[question] = (lapseQuestions[question] ?? 0) + 1;
    const stampResult = query.freshnessStamp?.result;
    const stampReason = STAMP_WITHOUT_COMPARISON.has(stampResult)
      ? `freshness-stamp-${stampResult}:${busyOverlap(query, trace.queries)}`
      : null;
    const { category, reason } = followUpFailureCategory(
      query,
      result,
      stampReason,
    );
    if (category === "setup-defect")
      invalid.push(`${query.queryId} reported ${reason} (setup defect)`);
    else categories[category] += 1;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    countStamp(stampWithoutComparison, reason);
  });
  if (invalid.length > 0) return invalidTrace(trace, invalid, Q, requeries);
  const outOfWindowU = U - displayed;
  const outOfWindow = Q - displayed;
  const lapseTotal = Object.values(lapses).reduce((sum, n) => sum + n, 0);
  const questions = Object.keys(lapseQuestions);
  return {
    kind: trace.kind,
    status: questions.length > 0 ? "precheck" : "valid",
    invalid: [],
    precheck:
      questions.length > 0
        ? [
            `[precheck] K6/4 変える点 15 keeps the lapse rate (K6/2 717 (i)〜(iv)) and does not say whether a follow-up that failed on these stages counts in it: ${questions.join(", ")}`,
          ]
        : [],
    lapseQuestions,
    regime: "k64",
    candidate: regime,
    Q,
    U,
    displayed,
    firstRenderInWindow,
    followUpDisplayed,
    outOfWindow,
    outOfWindowU,
    outOfWindowRate: ratio(outOfWindowU, U),
    outOfWindowExceeds: exceedsYardstick(outOfWindowU, U),
    lapse: { total: lapseTotal, ...lapses },
    lapseRate: ratio(lapseTotal, Q),
    lapseExceeds: exceedsYardstick(lapseTotal, Q),
    categories,
    reasons,
    x,
    q: {
      q1: distribution(q.q1),
      q2: distribution(q.q2),
      q3: distribution(q.q3),
    },
    boundaryDisagreement,
    stampWithoutComparison,
    ...traceDisclosure(counted),
    emptyContribution: lapses["iv-empty-contribution"],
    mainReason: mainReason(categories, outOfWindow),
    requeryCount: requeries.length,
  };
}

/**
 * (b) for one trace (rules 1-8). The trace is invalid (retake it, keep the
 * record) when Q < 200, a query ID repeats, a counted query lacks its
 * expected materials or records, a joined query lacks its edge count, a
 * query is not a seeded Graph query in the fixed mode, or a setup-defect
 * reason appears. With `candidate` (a K6/4-era run) every counted query must
 * come from the product hook consumer (R5, N16) and the K6/4 reading applies
 * when the candidate and the records qualify; otherwise K6/2 rules 2-5.
 */
export function summarizeTrace(input) {
  rejectOverrides(input, ["trace", "fixedGraphMode", "candidate"]);
  const { trace, fixedGraphMode } = input;
  const k64Era = Object.hasOwn(input, "candidate");
  if (trace?.kind !== "editing" && trace?.kind !== "browsing")
    throw new Error("[artifact] trace kind must be editing or browsing");
  const { counted, requeries } = separateRequeries(trace.queries);
  const invalid = [];
  const seen = new Set();
  for (const query of counted) {
    if (typeof query.queryId !== "string" || query.queryId.length === 0)
      invalid.push("a counted query lacks its queryId");
    else if (seen.has(query.queryId))
      invalid.push(`${query.queryId} is a duplicate queryId`);
    else seen.add(query.queryId);
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
    if (k64Era && query.followUp?.issuedVia !== PRODUCT_HOOK)
      invalid.push(
        `N16: ${query.queryId} was not issued through the product hook consumer (R5)`,
      );
  }
  const Q = counted.length;
  if (Q < TRACE_MIN_QUERIES)
    invalid.push(`trace has Q=${Q}, fewer than ${TRACE_MIN_QUERIES}`);
  if (invalid.length > 0) return invalidTrace(trace, invalid, Q, requeries);
  if (!k64Era) return summarizeTraceK62(trace, counted, requeries);
  const results = counted.map((query) =>
    classifyFollowUp(query, { context: "trace" }),
  );
  const regime = recordRegime(input.candidate, results);
  if (regime.regime !== "k64")
    return {
      ...summarizeTraceK62(trace, counted, requeries),
      k64NotApplied: regime.notApplied,
    };
  return summarizeTraceK64(trace, counted, requeries, results, regime);
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
 * A yardstick decision recomputed from the counts a summary carries (P2-5):
 * a missing or non-integer count is an artifact, never "no trigger".
 */
function recomputedExceeds(numerator, denominator, label) {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator))
    throw new Error(`[artifact] ${label} lacks its counts`);
  return exceedsYardstick(numerator, denominator);
}

function steadyGate(steadyState) {
  if (steadyState.regime === "k64") {
    const k64 = steadyState.k64;
    if (!k64 || !Array.isArray(k64.violations) || !Array.isArray(k64.holdCases))
      throw new Error(
        "[artifact] the K6/4 steady state lacks its display block",
      );
    if (k64.violations.length > 0)
      return { verdict: "FAIL", reason: "late-result-mixed-into-a-display" };
    if (k64.poolEmpty !== false || k64.display.n === 0)
      return { verdict: "HOLD", reason: "display-pool-empty" };
    if (k64.holdCases.length > 0)
      return { verdict: "HOLD", reason: "case-without-displayed-sample" };
    if (
      recomputedExceeds(
        k64.display.n - k64.display.displayed,
        k64.display.n,
        "the display pool",
      )
    )
      return { verdict: "HOLD", reason: "display-miss-rate-exceeds" };
    return null;
  }
  if (steadyState.regime !== undefined && steadyState.regime !== "k62")
    throw new Error(`[artifact] unknown regime ${steadyState.regime}`);
  if (
    recomputedExceeds(
      steadyState.pool?.outOfWindow,
      steadyState.pool?.n,
      "the (a) pool",
    )
  )
    return {
      verdict: "HOLD",
      reason: "steady-state-out-of-window-rate-exceeds",
    };
  return null;
}

function traceExceeds(trace) {
  return {
    outOfWindow: recomputedExceeds(
      trace.outOfWindowU,
      trace.U,
      `the ${trace.kind} trace window`,
    ),
    lapse: recomputedExceeds(
      trace.lapse?.total,
      trace.Q,
      `the ${trace.kind} trace lapses`,
    ),
  };
}

/**
 * CP-4 availability (TASK §15.4, K6/2 "条件が成立しない場合の CP-4 の可用性"
 * read through K6/4 変える点 3 when the steady state's regime is K6/4).
 * (a) above the yardstick is HOLD and the trace values are recorded and
 * disclosed only. (a) inside with a trace above it is HOLD and asks for the
 * (iii) diagnostic. A late result mixed into a display is FAIL (K6/4 :163).
 * Every yardstick decision is recomputed from counts (P2-5). A K6/4 trace
 * whose reading K6/4 leaves open returns `precheck` (blocked) instead of a
 * verdict.
 */
export function decideCp4Availability(input) {
  rejectOverrides(input, ["steadyState", "traces"]);
  const { steadyState, traces } = input;
  const disclose = {
    regime: steadyState?.regime ?? null,
    steadyState: steadyState?.pool ?? null,
    display: steadyState?.k64?.display ?? null,
    firstRenderOutOfWindowRate: steadyState?.pool?.outOfWindowRate ?? null,
    boundaryDisagreement: steadyState?.boundaryDisagreement ?? null,
    k64NotApplied: steadyState?.k64NotApplied ?? null,
    traces: (traces ?? []).map((trace) => ({
      kind: trace.kind,
      status: trace.status,
      regime: trace.regime ?? null,
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
  const gate = steadyGate(steadyState);
  if (gate)
    return {
      ...gate,
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
  if (traces.some((trace) => trace.status === "invalid"))
    return {
      verdict: "HOLD",
      reason: "trace-defect-retake",
      iiiDiagnosticRequired: false,
      disclose,
    };
  const regime = steadyState.regime ?? "k62";
  if (traces.some((trace) => (trace.regime ?? "k62") !== regime))
    return {
      verdict: "HOLD",
      reason: "trace-regime-differs-from-steady-state",
      iiiDiagnosticRequired: false,
      disclose,
    };
  const blocked = traces.filter((trace) => trace.status === "precheck");
  if (blocked.length > 0)
    return {
      verdict: "precheck",
      reason: "k64-reading-undecided",
      precheck: blocked.flatMap((trace) => trace.precheck ?? []),
      disclose,
    };
  if (traces.some((trace) => trace.status !== "valid"))
    return {
      verdict: "HOLD",
      reason: "trace-defect-retake",
      iiiDiagnosticRequired: false,
      disclose,
    };
  if (
    traces.some((trace) => {
      const exceeds = traceExceeds(trace);
      return exceeds.outOfWindow || exceeds.lapse;
    })
  )
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
 * Rule 6 for a condition-judging diagnostic ((i), (ii) or (iii)), read
 * through K6/4 変える点 2 and 15 when the steady state's regime is K6/4.
 * Only here can a trace's lapse rate raise `[precheck]`. (iii) must reuse
 * the trace file fixed before CP-4's observation.
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
    traces.some((t) => t.status === "invalid")
  )
    return { result: "invalid-retake" };
  const regime = steadyState.regime ?? "k62";
  if (traces.some((trace) => (trace.regime ?? "k62") !== regime))
    return { result: "row-not-used", reason: "trace-regime-differs" };
  if (traces.some((trace) => trace.status === "precheck"))
    return {
      result: "precheck",
      reason: "k64-reading-undecided",
      precheck: traces.flatMap((trace) => trace.precheck ?? []),
    };
  if (traces.some((t) => t.status !== "valid"))
    return { result: "invalid-retake" };
  const gate = steadyGate(steadyState);
  if (gate?.verdict === "FAIL") return { result: "fail", reason: gate.reason };
  if (gate)
    return { result: "row-not-used", reason: "steady-state-exceeds-hold" };
  const lapsing = traces.filter((trace) => traceExceeds(trace).lapse);
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
  const exceeding = traces.filter((trace) => traceExceeds(trace).outOfWindow);
  if (exceeding.length === 0)
    return { result: "condition-not-met", reason: "b-does-not-hold" };
  const mains = exceeding.map((trace) => trace.mainReason);
  if (mains.some((main) => main === "lapse" || main === "none"))
    return { result: "precheck", reason: "main-reason-lapse-or-none", mains };
  if (mains.some((main) => main === "other"))
    return { result: "row-not-used", reason: "main-reason-other", mains };
  return { result: "condition-met-confirmation-required", mains };
}
