// CP-4 S1c-2: the runner's pure parts (DR-CP4-S1C2-7〜10). One measured
// Related Scenes query (the harness page's `measure` summary), the Native
// evaluation record of its begin and the A3 record taken before it become
// one S1b sample row; the rows become the (a) preview summary and the run
// receipt.
//
// Two clocks never mix (native-sample.mjs): the window uses only renderer
// ms (tFetch, tRawReady, tReturn, graph.arrivedAt); Native ns are kept for
// order and attribution. The Native-derived "lower bound" of the Graph's
// arrival below is a disclosure column, never a window input.
//
// No Electron, no Native, no file here.

import {
  classifyJoin,
  steadyStateInWindow,
  summarizeSteadyState,
} from "./availability.mjs";
import {
  GRAPH_EVAL_D_MS,
  MEASURED_RUNS_PER_ARM,
  OWNER_REBUILD_MIN_INTERVAL_MS,
  WARMUP_RUNS_PER_ARM,
  exceedsYardstick,
  ratio,
} from "./constants.mjs";
import {
  nativeDurationMs,
  recordReadFromA3,
  sampleFieldsFromNativeRecord,
} from "./native-sample.mjs";
import { CP4_RECEIPT_SCHEMA, computeRunAggregates } from "./receipt.mjs";
import { distribution } from "./stats.mjs";

export const GRAPH_CONTINUE = "related_scenes_graph_continue";
export const BEGIN = "related_scenes_begin";
/** Begin answers that mean the B seal is not usable at the start. */
const B_UNUSABLE_REASONS = new Set(["registration-unavailable"]);

/**
 * The measurement Main's seam env (DR-CP4-S1C2-8). Always the K2/4 body
 * declaration CI seam (unpackaged, CI=true, the public owner token, a UUIDv4
 * nonce). `maintenance` is `"product"` (the product scheduler runs, as the
 * `maintenance-enabled` precondition requires) or the disclosed diagnostic
 * `"scheduler-disabled-for-launch"` (the existing C2-5B setup seam stops the
 * maintenance scheduler of this launch only; the persisted setting stays
 * on). Nothing else is accepted.
 */
export const MAINTENANCE_MODES = Object.freeze([
  "product",
  "scheduler-disabled-for-launch",
]);
export function measurementSeamEnv({
  bodyNonce,
  maintenance,
  maintenanceNonce,
}) {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (!uuid.test(bodyNonce ?? ""))
    throw new Error("[precheck] the body declaration nonce must be a UUIDv4");
  if (!MAINTENANCE_MODES.includes(maintenance))
    throw new Error(`[precheck] unknown maintenance mode ${maintenance}`);
  const env = {
    CI: "true",
    GRIMODEX_BODY_DECLARATION_CI_OWNER_TOKEN: "cb2-body-declaration-owner-v1",
    GRIMODEX_BODY_DECLARATION_CI_NONCE: bodyNonce,
  };
  if (maintenance === "scheduler-disabled-for-launch") {
    if (!uuid.test(maintenanceNonce ?? ""))
      throw new Error("[precheck] the maintenance seam nonce must be a UUIDv4");
    Object.assign(env, {
      GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN:
        "c2-5b-product-journey-owner-v1",
      GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_NONCE: maintenanceNonce,
      GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP: "disabled",
    });
  }
  return env;
}

/** The arms of each repeat, AB then BA (K6/2 step 2). */
/**
 * CQ-DEFER（D′、DR-CP4-S1C2-23）：Graph の sample の前の owner の前提。D′ の
 * Related Scenes の query は READY を残さない（保留つきの session は query の
 * 後に worker を退役させて slot を `empty` に戻す）ので、D′ 以前の「slot が新しい
 * READY」は成り立たない。代わりに、slot が `empty`（保留も、保留つきの session も、
 * Suspended も無い）、next-query cache が空、前の seed つきの sample の終わりから
 * owner の `rebuild_min_interval`（既定 1 s）以上経っていること（保留の release の
 * 後の rebuild の窓が 0 になり、prepare が release ですぐ始まる。製品の普通の場合）
 * を前提にする。
 */
export { OWNER_REBUILD_MIN_INTERVAL_MS };

export function quietAtStart({ slot, cacheOccupied, sinceLastSeededMs }) {
  return (
    slot === "empty" &&
    cacheOccupied === false &&
    (sinceLastSeededMs === null ||
      sinceLastSeededMs >= OWNER_REBUILD_MIN_INTERVAL_MS)
  );
}

export function scheduledArms(repeat) {
  return repeat % 2 === 0 ? ["hybrid", "graph"] : ["graph", "hybrid"];
}

/** The full predeclared schedule: warm-up 5, measured 30, both arms. */
export function runSchedule() {
  const rows = [];
  for (const [phase, count] of [
    ["warmup", WARMUP_RUNS_PER_ARM],
    ["measured", MEASURED_RUNS_PER_ARM],
  ])
    for (let repeat = 0; repeat < count; repeat++)
      for (const arm of scheduledArms(repeat))
        rows.push({ phase, repeat, arm });
  return rows;
}

/**
 * The renderer arrival of the Graph answer: the first (awaiting, not
 * settling) `related_scenes_graph_continue` call's resolution, with the
 * answer's status. Null when there was no such call.
 */
export function graphArrival(ipc) {
  const row = (ipc ?? []).find(
    (entry) => entry.cmd === GRAPH_CONTINUE && entry.settle === null,
  );
  if (!row) return null;
  return {
    calledAt: row.calledAt,
    resolvedAt: row.resolvedAt,
    status: row.status,
    reason: row.reason,
  };
}

function beginCall(ipc) {
  return (ipc ?? []).find((entry) => entry.cmd === BEGIN) ?? null;
}

/** `graphOutcome` of the product's join → the S1b `graph` record. */
export function graphRecord({ measure, arrival, native }) {
  const outcome = measure.graphOutcome;
  const base = {
    source: native?.source ?? null,
    busyCause: native?.busyCause ?? null,
  };
  const arrivedAvailable =
    arrival?.status === "available" && Number.isFinite(arrival.resolvedAt)
      ? arrival.resolvedAt
      : null;
  if (outcome === "graph-ready") {
    // P3-12: the product joins a Graph result only after the return-time
    // requalification (`assemble`), so "passed" is inferred from the join
    // contract; what this checks is that the requalified Graph payload (with
    // its edge count) reached the renderer. Without it the revalidation is
    // unknown and classifyJoin stops on the joined row.
    const payload =
      measure.graph !== null &&
      typeof measure.graph === "object" &&
      Number.isInteger(measure.graph.edgeCount) &&
      measure.graph.edgeCount >= 0;
    return {
      outcome: "graph-ready",
      reason: null,
      joined: true,
      arrivedAt: arrivedAvailable,
      revalidation: payload ? "passed" : null,
      edgeCount: payload ? measure.graph.edgeCount : null,
      ...base,
    };
  }
  if (outcome === "graph-late")
    return {
      outcome: "graph-late",
      reason: null,
      joined: false,
      arrivedAt: arrivedAvailable,
      revalidation: null,
      edgeCount: null,
      ...base,
    };
  const reason =
    typeof outcome === "string" && outcome.startsWith("graph-unavailable:")
      ? outcome.slice("graph-unavailable:".length)
      : "failed";
  return {
    outcome: "graph-unavailable",
    reason,
    joined: false,
    arrivedAt: null,
    revalidation: null,
    edgeCount: null,
    ...base,
  };
}

/** The A3 record → `a3AtStart` (expected materials eligible at the start). */
export function a3AtStartOf(a3) {
  const revisions = a3?.revisions ?? [];
  const reasons = revisions
    .filter((row) => row.a3 !== "eligible")
    .map((row) => row.reason ?? "unavailable");
  return { eligible: revisions.length > 0 && reasons.length === 0, reasons };
}

/**
 * The B seal at the start of one query (K6/2 rule 1: U is the queries whose
 * snapshot is usable, i.e. the B seal is current): the begin's Native answer
 * (`registration-unavailable` is the B seal). The Chronicle Index is not part
 * of `usable` (P2-4: rule 3 (i) keeps a Chronicle stop in U); it is recorded
 * as `chronicleIndexUsable` and identifies the stop through `irOutcome`.
 */
export function snapshotOf({ measure, nativeRecord }) {
  const chronicleIndexUsable = measure.initialSnapshot?.indexUsable === true;
  if (
    nativeRecord?.begin === "unavailable" &&
    B_UNUSABLE_REASONS.has(nativeRecord.reason)
  )
    return { usable: false, reason: nativeRecord.reason, chronicleIndexUsable };
  return { usable: true, reason: null, chronicleIndexUsable };
}

/**
 * The query's IR outcome for K6/2 rule 3 (i): `index-unavailable` when the
 * Chronicle Index was not usable at the start (the product's first snapshot;
 * `begin.rs` answers the IR unavailable then), otherwise the IR completion.
 */
export function irOutcomeOf(measure) {
  if (measure.initialSnapshot?.indexUsable === false)
    return "index-unavailable";
  return measure.completion?.outcome ?? null;
}

/**
 * One measured query → one S1b sample row. `nativeRecord` is the single
 * `nir1GraphEvalSamples` record of a seeded query (the log is cleared before
 * each sample) and `a3` the A3 record taken just before it.
 */
export function sampleRow({
  variantKey,
  arm,
  phase,
  repeat,
  d2aMode,
  measure,
  nativeRecord = null,
  a3 = null,
  readyWait = null,
}) {
  const seeded = arm === "graph";
  const row = {
    variantKey,
    arm,
    phase,
    repeat,
    trigger: "user-operation",
    seeded,
    graphEnabled: seeded,
    d2aMode,
    tFetch: measure.timing.tFetchMs,
    tRawReady: measure.timing.tRawReadyMs,
    tReturn: measure.timing.tReturnMs,
    status: measure.status,
    irOutcome: irOutcomeOf(measure),
    irCompletion: measure.completion?.outcome ?? null,
    rawSceneIds: measure.rawSceneIds,
    finalSceneIds: measure.finalSceneIds,
  };
  if (!seeded) return row;
  if (!nativeRecord)
    throw new Error("[artifact] a seeded query left no Native begin record");
  if (
    measure.initialSnapshot === null ||
    typeof measure.initialSnapshot !== "object" ||
    typeof measure.initialSnapshot.indexUsable !== "boolean"
  )
    throw new Error(
      "[artifact] a seeded query lacks the product's initial snapshot (K6/2 Mandatory defenses)",
    );
  const native = sampleFieldsFromNativeRecord(nativeRecord);
  const arrival = graphArrival(measure.ipc);
  const begin = beginCall(measure.ipc);
  if (!begin || !Number.isFinite(begin.resolvedAt))
    throw new Error(
      "[artifact] the timing shim recorded no answered begin for a seeded query",
    );
  return {
    ...row,
    snapshot: snapshotOf({ measure, nativeRecord }),
    a3AtStart: a3AtStartOf(a3),
    startSlot: native.startSlot,
    freshnessStamp: native.freshnessStamp,
    recordRead: a3 ? recordReadFromA3(a3) : null,
    graph: graphRecord({ measure, arrival, native }),
    nativeBegin: {
      begin: nativeRecord.begin,
      reason: nativeRecord.reason ?? null,
      ticket: native.ticket ?? null,
      timing: native.timing,
    },
    disclosure: disclosureOf({ measure, native, arrival, begin }),
    readyWait,
  };
}

/**
 * Disclosure-only durations. `lowerBoundArrivalAfterRawReadyMs` places the
 * Native ticket's settlement on the renderer timeline from the begin call
 * (the Native begin starts after the call, so this is a lower bound of the
 * Native completion, and the renderer sees it only later). Never a window
 * input.
 */
export function disclosureOf({ measure, native, arrival, begin }) {
  const ticket = native.ticket ?? null;
  const settledMs =
    ticket?.settledNs !== null && ticket?.settledNs !== undefined
      ? nativeDurationMs(native.timing.beginNs, ticket.settledNs)
      : null;
  const workerMs =
    ticket?.settledNs !== null && ticket?.settledNs !== undefined
      ? nativeDurationMs(ticket.ticketNs, ticket.settledNs)
      : null;
  const beginToRawReadyMs =
    begin && Number.isFinite(measure.timing.tRawReadyMs)
      ? measure.timing.tRawReadyMs - begin.calledAt
      : null;
  return {
    rawReadyAfterFetchMs: measure.timing.tRawReadyMs - measure.timing.tFetchMs,
    returnAfterRawReadyMs:
      measure.timing.tReturnMs - measure.timing.tRawReadyMs,
    beginIpcMs:
      begin && Number.isFinite(begin.resolvedAt)
        ? begin.resolvedAt - begin.calledAt
        : null,
    graphAnswerAfterRawReadyMs:
      arrival && Number.isFinite(arrival.resolvedAt)
        ? arrival.resolvedAt - measure.timing.tRawReadyMs
        : null,
    graphAnswerStatus: arrival?.status ?? null,
    nativeBeginToSettledMs: settledMs,
    nativeWorkerMs: workerMs,
    lowerBoundArrivalAfterRawReadyMs:
      settledMs !== null && beginToRawReadyMs !== null
        ? settledMs - beginToRawReadyMs
        : null,
  };
}

export { distribution, nearestRank } from "./stats.mjs";

/**
 * The single attributed cause of one measured R+IR+Graph sample that is not
 * in the (a) window, in a fixed order: cache origin, Busy (by cause), other
 * unavailable reasons, not a new READY at the start, stamp mismatch, stamp
 * without comparison, worker late (fresh start, matched stamp, late), the
 * boundary disagreement, other.
 */
export function windowOutCause(sample) {
  const graph = sample.graph;
  if (graph.source === "cache") return "cache-origin";
  if (graph.reason === "busy") return `busy:${graph.busyCause ?? "unrecorded"}`;
  if (graph.outcome === "graph-unavailable")
    return `unavailable:${graph.reason}`;
  if (sample.startSlot?.readyFresh !== true) return "not-ready-at-start";
  if (sample.freshnessStamp?.matched === false) return "stamp-mismatch";
  if (sample.freshnessStamp?.matched !== true)
    return "stamp-without-comparison";
  if (graph.outcome === "graph-late") return "worker-late";
  if (classifyJoin(sample).disagreement) return "boundary-disagreement";
  return "other";
}

function countBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const value = key(row);
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

/**
 * The (a) preview of one run: the S1b steady-state summary on the dev plan,
 * the in-window rate against the 1% yardstick, the distributions and the
 * window-out breakdown. Always `preview: true`.
 */
export function previewSummary({ samples, variant }) {
  const steadyState = summarizeSteadyState({
    samples,
    fixedGraphMode: "restricted",
    plan: {
      kind: "dev",
      variants: [{ key: variant.key, expectedGraph: variant.expectedGraph }],
    },
  });
  const measured = samples.filter(
    (row) => row.arm === "graph" && row.phase === "measured",
  );
  const out = measured.filter((row) => !steadyStateInWindow(row));
  const flags = {
    cacheOrigin: measured.filter((row) => row.graph.source === "cache").length,
    notReadyAtStart: measured.filter(
      (row) => row.startSlot?.readyFresh !== true,
    ).length,
    stampMismatch: measured.filter(
      (row) => row.freshnessStamp?.matched === false,
    ).length,
    stampWithoutComparison: measured.filter(
      (row) => row.freshnessStamp && row.freshnessStamp.matched === null,
    ).length,
    busy: countBy(
      measured.filter((row) => row.graph.reason === "busy"),
      (row) => row.graph.busyCause ?? "unrecorded",
    ),
    graphLate: measured.filter((row) => row.graph.outcome === "graph-late")
      .length,
    workerLate: measured.filter(
      (row) =>
        row.graph.outcome === "graph-late" &&
        row.graph.source === "worker" &&
        row.startSlot?.readyFresh === true &&
        row.freshnessStamp?.matched === true,
    ).length,
  };
  const inWindow = measured.length - out.length;
  return {
    preview: true,
    notACp4Result:
      "dev fixture preview (kind dev); never a formal CP-4 measurement",
    dMs: GRAPH_EVAL_D_MS,
    n: measured.length,
    inWindow,
    inWindowRate: ratio(inWindow, measured.length),
    outOfWindowRate: ratio(out.length, measured.length),
    exceedsYardstick:
      measured.length > 0
        ? exceedsYardstick(out.length, measured.length)
        : null,
    outcomes: countBy(measured, (row) =>
      row.graph.outcome === "graph-unavailable"
        ? `graph-unavailable:${row.graph.reason}`
        : row.graph.outcome,
    ),
    windowOutCauses: countBy(out, windowOutCause),
    flags,
    distributions: {
      graphAnswerAfterRawReadyMs: distribution(
        measured.map((row) => row.disclosure.graphAnswerAfterRawReadyMs),
      ),
      joinedArrivalAfterRawReadyMs: distribution(
        measured
          .filter((row) => row.graph.joined)
          .map((row) => row.graph.arrivedAt - row.tRawReady),
      ),
      lowerBoundArrivalAfterRawReadyMs: distribution(
        measured.map((row) => row.disclosure.lowerBoundArrivalAfterRawReadyMs),
      ),
      nativeWorkerMs: distribution(
        measured.map((row) => row.disclosure.nativeWorkerMs),
      ),
      nativeBeginToSettledMs: distribution(
        measured.map((row) => row.disclosure.nativeBeginToSettledMs),
      ),
      rawReadyAfterFetchMs: distribution(
        measured.map((row) => row.disclosure.rawReadyAfterFetchMs),
      ),
      hybridRawReadyAfterFetchMs: distribution(
        samples
          .filter((row) => row.arm === "hybrid" && row.phase === "measured")
          .map((row) => row.tRawReady - row.tFetch),
      ),
    },
    steadyState: {
      status: steadyState.status,
      invalid: steadyState.invalid,
      pool: steadyState.pool,
      qualityHoldVariants: steadyState.qualityHoldVariants,
      boundaryDisagreement: steadyState.boundaryDisagreement,
    },
  };
}

/** Pools several preview runs: per-run rates and the pooled rate. */
export function aggregatePreviews(previews) {
  const runs = previews.map((row) => ({
    runId: row.runId,
    n: row.preview.n,
    inWindow: row.preview.inWindow,
    inWindowRate: row.preview.inWindowRate,
    windowSampleViolations: row.windowViolations ?? null,
  }));
  const n = runs.reduce((sum, row) => sum + row.n, 0);
  const inWindow = runs.reduce((sum, row) => sum + row.inWindow, 0);
  const rates = runs.map((row) => row.inWindowRate).filter(Number.isFinite);
  return {
    preview: true,
    runs,
    pooled: {
      n,
      inWindow,
      inWindowRate: ratio(inWindow, n),
      outOfWindowRate: ratio(n - inWindow, n),
      exceedsYardstick: n > 0 ? exceedsYardstick(n - inWindow, n) : null,
    },
    inWindowRateRange: rates.length
      ? { min: Math.min(...rates), max: Math.max(...rates) }
      : null,
  };
}

/**
 * The `nir1-cp4-run-receipt/1` of one dev preview run. The aggregates are
 * computed with `computeRunAggregates`, the same function the validator
 * recomputes.
 */
export function assembleRunReceipt({
  runId,
  fixture,
  variant,
  head,
  candidate,
  environment,
  run,
  settings,
  declaration,
  measurementWorkspace,
  samples,
  checks,
}) {
  const receipt = {
    schemaVersion: CP4_RECEIPT_SCHEMA,
    runKind: "g-case-gold",
    runId,
    preview: true,
    previewNote:
      "dev fixture preview (S1c-2, TASK §15.9): seen by the integrator only; not a formal CP-4 measurement, never aggregated with formal receipts",
    fixture,
    head,
    candidate,
    environment,
    run,
    settings: {
      ...settings,
      variantKey: variant.key,
      devVariant: { key: variant.key, expectedGraph: variant.expectedGraph },
    },
    declaration,
    measurementWorkspace,
    samples,
    requeries: [],
    checks,
  };
  receipt.aggregates = computeRunAggregates(receipt, variant);
  receipt.preview = true;
  receipt.previewSummary = previewSummary({ samples, variant });
  receipt.verdict = {
    outcome: "preview-only",
    note: "the dev variant is never a CP-4 result (availability.mjs dev-plan-is-never-a-cp4-result)",
  };
  return receipt;
}
