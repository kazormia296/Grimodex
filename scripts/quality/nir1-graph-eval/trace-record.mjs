/* global process, setInterval, clearInterval */
// CP-4 TR: the (b) trace records (pure part). DR-CP4-TR-1〜3.
//
// K6/2 `graph-eval-procedure` step 4 and 「条件の (b) の判定の規則」 1-8, read
// through K6/4 変える点 15 (判断 8 (ii)) and R8. A trace run replays the
// operations of a trace file (S2: `evals/nir1-graph/trace-{editing,browsing}.v1.json`,
// schema `nir1-cp4-trace/1`) on the product editor, the product autosave and
// the product hook consumer (R5); this module turns what the runner observed
// into the rows `summarizeTrace` reads and the events `validateTraceEvents`
// reads. The classifier (followup.mjs, availability.mjs) is not changed.
//
// One counted query = the first fetch the product issued for the query Scene
// after the operation (the autosave commit, the navigation, the open). Its
// row is the steady-state producer's (`k64GraphSampleRow`) on the observation
// window from that fetch's call to the next counted query's call, with the
// trace differences (変える点 15: R1, R2 do not apply; F2 is read between the
// parent's and the child's begin):
//   - `followUp.counters` are the owner counters at the query boundary, read
//     by the Main poller (TR-2): the last read that finished at or before the
//     parent's Native begin and the first read that started at or after the
//     child's Native begin returned. The interval contains the true one (the
//     strict side); no read is a missing record (X10).
//   - `followUp.nativeBegins` are the Native begin records from the parent's
//     to the child's (by seq), whoever issued them.
// Re-queries (`graph-ready`, `index-ready`, the IR retry) and queries without
// a seed (outside Q) are counted apart and are never rows (DR-CP4-TR-3).
//
// Clocks (R6): renderer `performance.now()` ms for every window input; the
// evaluation Native ns for the boundary counters and the begin records only.
// The two are never converted into each other.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { summarizeTrace, validateTraceEvents } from "./availability.mjs";
import { K64_W_F_MS, TRACE_MIN_QUERIES } from "./constants.mjs";
import { PRODUCT_HOOK } from "./followup.mjs";
import { finite } from "./join.mjs";
import { k64GraphSampleRow } from "./k64-record.mjs";
import { BEGIN, GRAPH_CONTINUE, a3AtStartOf } from "./run-sample.mjs";

export const TRACE_FILE_SCHEMA = "nir1-cp4-trace/1";
export const TRACE_RUN_SCHEMA = "nir1-cp4-trace-run/1";
export const TRACE_KINDS = Object.freeze(["editing", "browsing"]);
/** The owner counters the Main poller keeps (diagnostics keys). */
export const TRACE_COUNTER_KEYS = Object.freeze([
  "begins",
  "cacheHits",
  "lateCached",
  "quarantines",
  "deferredReleased",
  "deferredExpired",
  "deferredDropped",
  "staleReadyRetired",
  "prepareFailures",
  "driftAtQuery",
  "stamp0Missing",
]);
/** The Main poller's interval (a harness value, not a K6/4 value). */
export const COUNTER_POLL_INTERVAL_MS = 5;
/** P2-3's React commit margin after the mixing window's conditions hold. */
export const MIX_COMMIT_MARGIN_MS = 16;
const EDIT_ACTIONS = new Set(["append-suffix", "remove-suffix"]);
const SHA256_HEX = /^[0-9a-f]{64}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- the trace file ---------------------------------------------------------

/**
 * The checks of a trace plan the runner relies on (the S2 review and
 * `eval:fixtures` check the rest). `preview` allows a short dev plan only.
 */
export function validateTracePlan(plan, { preview = false } = {}) {
  const errors = [];
  if (plan?.schemaVersion !== TRACE_FILE_SCHEMA)
    errors.push(`schemaVersion must be ${TRACE_FILE_SCHEMA}`);
  if (!TRACE_KINDS.includes(plan?.kind))
    errors.push("kind must be editing or browsing");
  if (typeof plan?.traceId !== "string" || plan.traceId.length === 0)
    errors.push("traceId is required");
  if (typeof plan?.querySceneId !== "string")
    errors.push("querySceneId is required");
  const seed = plan?.seed?.entityId;
  if (typeof seed !== "string") errors.push("seed.entityId is required");
  if (
    !Array.isArray(plan?.expectedMaterials) ||
    plan.expectedMaterials.length === 0 ||
    !plan.expectedMaterials.every((row) => typeof row?.revisionId === "string")
  )
    errors.push("expectedMaterials must name at least one revisionId");
  const bound = plan?.stall?.boundMs;
  if (!Number.isInteger(bound) || bound <= 0 || bound > 60_000)
    errors.push("stall.boundMs must be a positive integer up to 60000");
  const operations = Array.isArray(plan?.operations) ? plan.operations : [];
  if (operations.length === 0) errors.push("operations are required");
  let counted = 0;
  operations.forEach((row, at) => {
    if (row?.seq !== at) errors.push(`operation ${at} has seq ${row?.seq}`);
    const allowed =
      plan?.kind === "editing"
        ? ["open-scene", "edit", "confirm-autosave-commit", "product-query"]
        : ["open-scene", "navigate"];
    if (!allowed.includes(row?.op))
      errors.push(`operation ${at}: unknown op ${row?.op} for ${plan?.kind}`);
    if (row?.op === "edit") {
      if (row.via !== "product-editor")
        errors.push(`operation ${at}: edits go through the product-editor`);
      if (!EDIT_ACTIONS.has(row.action))
        errors.push(`operation ${at}: unknown edit action ${row.action}`);
      if (row.sceneId !== plan.querySceneId)
        errors.push(`operation ${at}: edits only the query Scene`);
    }
    const query = row?.query;
    if (query?.counted === true) {
      if (query.index !== counted)
        errors.push(
          `operation ${at}: counted query index ${query.index}, expected ${counted}`,
        );
      if (query.querySceneId !== plan.querySceneId)
        errors.push(`operation ${at}: counted query on another Scene`);
      if (query.seed !== seed)
        errors.push(`operation ${at}: counted query with another seed`);
      counted += 1;
    } else if (query && query.seed !== null)
      errors.push(`operation ${at}: an uncounted query must have no seed`);
  });
  if (operations[0]?.op !== "open-scene" || !operations[0]?.query?.counted)
    errors.push("the first operation opens the query Scene (counted query 0)");
  // The cycle pattern (S2 `cyclePattern`): editing is edit → confirm →
  // product-query; browsing alternates the other Scene and the query Scene.
  for (let at = 1; at < operations.length; at++) {
    const position = (at - 1) % (plan?.kind === "editing" ? 3 : 2);
    const op = operations[at]?.op;
    const expected =
      plan?.kind === "editing"
        ? ["edit", "confirm-autosave-commit", "product-query"][position]
        : "navigate";
    if (op !== expected)
      errors.push(`operation ${at} breaks the cycle pattern (${op})`);
    if (
      plan?.kind === "browsing" &&
      op === "navigate" &&
      (position === 0) !== (operations[at].sceneId !== plan.querySceneId)
    )
      errors.push(`operation ${at} breaks the cycle pattern (scene)`);
    if (plan?.kind === "editing" && position === 2 && !operations[at].query)
      errors.push(`operation ${at}: product-query without its query`);
  }
  if ((operations.length - 1) % (plan?.kind === "editing" ? 3 : 2) !== 0)
    errors.push("the operations end inside a cycle");
  if (plan?.plannedQ !== counted)
    errors.push(`plannedQ ${plan?.plannedQ} differs from ${counted} counted`);
  if (!preview && counted < TRACE_MIN_QUERIES)
    errors.push(`the trace plans ${counted} queries, fewer than 200`);
  if (plan?.kind === "editing" && typeof plan?.editText?.suffix !== "string")
    errors.push("editText.suffix is required");
  if (
    plan?.kind === "browsing" &&
    typeof plan?.browse?.otherSceneId !== "string"
  )
    errors.push("browse.otherSceneId is required");
  return errors;
}

/**
 * Reads a trace file: from `commit` (a fixed trace; the bytes of that commit)
 * or from the working tree (a dev preview only). Throws `[precheck]`.
 */
export function loadTracePlan({ root, file, commit = null, preview = false }) {
  const relative = path.relative(root, path.resolve(root, file));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("[precheck] the trace file is outside the candidate");
  let bytes;
  try {
    bytes =
      commit === null
        ? readFileSync(path.join(root, relative))
        : execFileSync("git", ["show", `${commit}:${relative}`], {
            cwd: root,
            maxBuffer: 64 * 1024 * 1024,
          });
  } catch {
    throw new Error(`[precheck] the trace file ${relative} cannot be read`);
  }
  if (commit === null && !preview)
    throw new Error("[precheck] a fixed trace is read from its commit");
  let plan;
  try {
    plan = JSON.parse(bytes);
  } catch {
    throw new Error("[precheck] the trace file is not JSON");
  }
  const errors = validateTracePlan(plan, { preview });
  if (errors.length > 0)
    throw new Error(`[precheck] the trace file: ${errors.join("; ")}`);
  return Object.freeze({
    plan,
    path: relative.split(path.sep).join("/"),
    sha256: sha256(bytes),
    commit,
  });
}

/**
 * A short dev plan in the S2 shape (dev preview only; never a fixed trace).
 * `materials` are the expected materials' logical revision IDs.
 */
export function devTracePlan({
  kind,
  cycles,
  querySceneId,
  otherSceneId,
  seedEntityId,
  materials,
}) {
  const query = (index) => ({
    index,
    counted: true,
    querySceneId,
    seed: seedEntityId,
    expectedMaterials: [...materials],
  });
  const operations = [
    {
      seq: 0,
      op: "open-scene",
      sceneId: querySceneId,
      until: "cycle-end",
      query: query(0),
    },
  ];
  for (let cycle = 1; cycle <= cycles; cycle++)
    if (kind === "editing")
      operations.push(
        {
          seq: operations.length,
          op: "edit",
          via: "product-editor",
          sceneId: querySceneId,
          action: cycle % 2 === 1 ? "append-suffix" : "remove-suffix",
        },
        {
          seq: operations.length + 1,
          op: "confirm-autosave-commit",
          sceneId: querySceneId,
        },
        {
          seq: operations.length + 2,
          op: "product-query",
          trigger: "autosave-commit",
          until: "cycle-end",
          query: query(cycle),
        },
      );
    else
      operations.push(
        {
          seq: operations.length,
          op: "navigate",
          sceneId: otherSceneId,
          until: "query-published",
          query: {
            counted: false,
            querySceneId: otherSceneId,
            seed: null,
            expectedMaterials: [],
          },
        },
        {
          seq: operations.length + 1,
          op: "navigate",
          sceneId: querySceneId,
          until: "cycle-end",
          query: query(cycle),
        },
      );
  return {
    schemaVersion: TRACE_FILE_SCHEMA,
    traceId: `cp4-dev-trace-${kind}/preview`,
    kind,
    status: "dev-preview",
    querySceneId,
    seed: { entityId: seedEntityId },
    expectedMaterials: materials.map((revisionId) => ({ revisionId })),
    stall: { boundMs: 10_000, attemptLimit: 2 },
    ...(kind === "editing"
      ? { editText: { suffix: " The lamp flickered." } }
      : { browse: { otherSceneId } }),
    cycles,
    plannedQ: cycles + 1,
    operations,
  };
}

// ---- the boundary counters (TR-2) ------------------------------------------

/**
 * Appends one poll `{ beforeNs, counters, afterNs }` to the runs (equal
 * consecutive counters share a run). The Main poller (COUNTER_POLL_SOURCE)
 * inlines the same logic; a test checks they agree.
 */
export function appendCounterRun(runs, poll) {
  const key = TRACE_COUNTER_KEYS.map((name) => poll.counters[name]).join(",");
  const last = runs.at(-1);
  if (last && last.key === key) {
    last.lastBeforeNs = poll.beforeNs;
    last.lastAfterNs = poll.afterNs;
    last.polls += 1;
    return runs;
  }
  runs.push({
    key,
    counters: Object.fromEntries(
      TRACE_COUNTER_KEYS.map((name) => [name, poll.counters[name]]),
    ),
    firstBeforeNs: poll.beforeNs,
    firstAfterNs: poll.afterNs,
    lastBeforeNs: poll.beforeNs,
    lastAfterNs: poll.afterNs,
    polls: 1,
  });
  return runs;
}

/**
 * The counters around [beginNs, endNs]: `before` from the last read that
 * finished at or before `beginNs`, `after` from the first read that started at
 * or after `endNs`. `read` is "exact" when `lateCached` did not change across
 * either end (monotonic counters: equal reads on both sides of an end mean no
 * change at it), else "bracketed" (the gaps are disclosed). Null when a side
 * has no read.
 */
export function boundaryCounters(runs, { beginNs, endNs }) {
  if (!Array.isArray(runs) || !finite(beginNs) || !finite(endNs)) return null;
  const before = runs.findLast((run) => run.firstAfterNs <= beginNs);
  const after = runs.find((run) => run.lastBeforeNs >= endNs);
  if (!before || !after) return null;
  const nextAtBegin = runs.find((run) => run.lastBeforeNs >= beginNs);
  const lastAtEnd = runs.findLast((run) => run.firstAfterNs <= endNs);
  const exactBegin =
    nextAtBegin !== undefined &&
    nextAtBegin.counters.lateCached === before.counters.lateCached;
  const exactEnd =
    lastAtEnd !== undefined &&
    lastAtEnd.counters.lateCached === after.counters.lateCached;
  return {
    before: { ...before.counters },
    after: { ...after.counters },
    read: exactBegin && exactEnd ? "exact" : "bracketed",
    beforeGapNs:
      before.lastAfterNs <= beginNs ? beginNs - before.lastAfterNs : 0,
    afterGapNs: after.firstBeforeNs >= endNs ? after.firstBeforeNs - endNs : 0,
  };
}

/**
 * Installed in the measurement Main through `app.evaluate` (self-contained:
 * it is serialized). Every `intervalMs` one tick reads the evaluation clock
 * and then the owner diagnostics (whose `clockNs` is taken after its counters)
 * synchronously and keeps runs of equal counters (appendCounterRun's logic).
 * It reads evaluation entries only and writes nothing.
 */
export const COUNTER_POLL_SOURCE = async (
  _electron,
  [file, intervalMs, keys],
) => {
  const Module = process.getBuiltinModule("node:module");
  const native = Module.createRequire(file)(file);
  const previous = globalThis.__cp4TraceCounterPoll;
  if (previous?.timer) clearInterval(previous.timer);
  const state = {
    runs: [],
    polls: 0,
    errors: 0,
    lastError: null,
    timer: null,
    intervalMs,
  };
  globalThis.__cp4TraceCounterPoll = state;
  const tick = () => {
    try {
      const beforeNs = Number(native.nir1GraphEvalClockNs());
      const diagnostics = JSON.parse(native.nir1GraphEvalDiagnostics());
      const afterNs = diagnostics.clockNs;
      const key = keys.map((name) => diagnostics[name]).join(",");
      const last = state.runs[state.runs.length - 1];
      state.polls += 1;
      if (last && last.key === key) {
        last.lastBeforeNs = beforeNs;
        last.lastAfterNs = afterNs;
        last.polls += 1;
        return;
      }
      state.runs.push({
        key,
        counters: Object.fromEntries(
          keys.map((name) => [name, diagnostics[name]]),
        ),
        firstBeforeNs: beforeNs,
        firstAfterNs: afterNs,
        lastBeforeNs: beforeNs,
        lastAfterNs: afterNs,
        polls: 1,
      });
    } catch (error) {
      state.errors += 1;
      state.lastError = String(error?.message ?? error);
    }
  };
  tick();
  state.timer = setInterval(tick, intervalMs);
  // Never what keeps a process alive (the Main's own loop does).
  state.timer.unref?.();
  return JSON.stringify({ installed: true, intervalMs });
};

/** Returns what the poller kept (the runs are not cleared). */
export const COUNTER_POLL_DRAIN_SOURCE = async () => {
  const state = globalThis.__cp4TraceCounterPoll;
  if (!state) return JSON.stringify({ installed: false });
  return JSON.stringify({
    installed: true,
    running: state.timer !== null,
    intervalMs: state.intervalMs,
    polls: state.polls,
    errors: state.errors,
    lastError: state.lastError,
    runs: state.runs,
  });
};

export const COUNTER_POLL_STOP_SOURCE = async () => {
  const state = globalThis.__cp4TraceCounterPoll;
  if (!state) return JSON.stringify({ stopped: false });
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  return JSON.stringify({ stopped: true, polls: state.polls });
};

// ---- the Native begin records ----------------------------------------------

/**
 * Merges `nir1GraphEvalSamples` reads taken during the trace in read order
 * (the log is cleared once before the trace, then only read): one record per
 * seq, the later read's state (a ticket settles later). The Native log keeps
 * 1,024 records and counts the ones it pushed out (`dropped`, cumulative since
 * the clear), so `dropped` alone is not a loss (レビュー P2-4): a record is lost
 * only when the merged seqs have a gap, or when the first read already counts
 * dropped records (pushed out before any read). The seq is the Native's
 * per-begin counter (`NEXT_SEQ`), consecutive for the registered owner.
 */
export function mergeNativeRecords(reads) {
  const bySeq = new Map();
  let dropped = 0;
  let frontLoss = false;
  reads.forEach((read, at) => {
    dropped = Math.max(dropped, read?.dropped ?? 0);
    for (const record of read?.records ?? []) bySeq.set(record.seq, record);
    if (at === 0 && (read?.dropped ?? 0) > 0) frontLoss = true;
  });
  const records = [...bySeq.values()].sort(
    (left, right) => left.seq - right.seq,
  );
  // 再レビュー P3: every begin since the clear is either still in the last
  // read's log or counted in its (cumulative) `dropped`; fewer merged records
  // than that is a loss even without a gap in the seqs (an empty early read).
  const last = reads.at(-1);
  const missing = Math.max(
    0,
    (last?.dropped ?? 0) + (last?.records?.length ?? 0) - bySeq.size,
  );
  const gaps = [];
  for (let at = 1; at < records.length; at++)
    if (records[at].seq !== records[at - 1].seq + 1)
      gaps.push([records[at - 1].seq, records[at].seq]);
  return {
    dropped,
    records,
    gaps,
    frontLoss,
    missing,
    lost: frontLoss || gaps.length > 0 || missing > 0,
    // DR-CP4-V-3: each read's Native clock (`clockNs`, taken by the read),
    // in read order, for the independent clock range of the pairing.
    clocks: reads.map((read) =>
      Number.isSafeInteger(read?.clockNs) ? read.clockNs : null,
    ),
  };
}

/** The fetch an API row belongs to: the latest one called at or before it. */
function ownerOf(fetches, row) {
  let owner = null;
  for (const fetch of fetches)
    if (fetch.calledAt <= row.calledAt) owner = fetch;
  return owner;
}

const byCall = (left, right) => left.calledAt - right.calledAt;

const NS_PER_MS = 1e6;

/**
 * DR-CP4-V-2: the range of (Native clock − renderer clock), in ms, the paired
 * begins allow: a Native begin starts after its renderer call and returns
 * before the renderer sees the answer, so the difference is at most
 * `tBeginNs − calledAt` and at least `tReturnedNs − resolvedAt` of every pair.
 * Empty (lower > upper) when the pairs are out of order.
 */
function clockBracket(begins, records) {
  let lower = -Infinity;
  let upper = Infinity;
  begins.forEach((row, at) => {
    const record = records[at];
    if (finite(record?.tBeginNs) && finite(row.calledAt))
      upper = Math.min(upper, record.tBeginNs / NS_PER_MS - row.calledAt);
    if (finite(record?.tReturnedNs) && finite(row.resolvedAt))
      lower = Math.max(lower, record.tReturnedNs / NS_PER_MS - row.resolvedAt);
  });
  return { lower, upper };
}

/** The earliest renderer time a runner log row was taken at (or NaN). */
function loggedAt(row) {
  const times = [row?.caretAt, row?.startedAt, row?.at].filter(finite);
  return times.length > 0 ? Math.min(...times) : NaN;
}

/**
 * DR-CP4-V-3: the range of (Native clock − renderer clock), in ms, the
 * runner's Native reads allow, independent of the pairing. The runner reads
 * the Native records once after each counted query's cycle end and once after
 * the page exported its observation (trace-runner.mjs `runTraceOperations`
 * and the read after `exportObservation`); each read's `clockNs` was taken
 * after the cycle end's renderer time (`cycleEnd.at`) and before the next
 * logged operation's renderer time (an edit's caret, a move, a seal read;
 * `observedUntil` after the last cycle), the final read after
 * `observedUntil`. Null with the reason when the reads do not match that
 * order (count, clock or times missing).
 */
export function nativeReadClockRange({ log, observation, native }) {
  const clocks = native?.clocks;
  const rows = log ?? [];
  const entries = rows.filter((row) => Number.isInteger(row.parentSeq));
  const until = observation?.observedUntil;
  const unknown = (reason) => ({ range: null, reason });
  if (!Array.isArray(clocks) || clocks.length !== entries.length + 1)
    return unknown(
      `${Array.isArray(clocks) ? clocks.length : 0} Native reads for ${entries.length} counted queries (one after each cycle end and one after the window)`,
    );
  if (!finite(until)) return unknown("the observation has no observedUntil");
  const bounds = entries.map((entry) => {
    const next = rows
      .slice(rows.indexOf(entry) + 1)
      .find((row) => finite(loggedAt(row)));
    return {
      lower: entry.cycleEnd?.at,
      upper: next ? loggedAt(next) : until,
    };
  });
  bounds.push({ lower: until, upper: Infinity });
  let lower = -Infinity;
  let upper = Infinity;
  for (const [at, clock] of clocks.entries()) {
    const bound = bounds[at];
    if (clock === null) return unknown(`Native read ${at} has no clockNs`);
    if (!finite(bound.lower) || !(bound.lower <= bound.upper))
      return unknown(`Native read ${at} has no renderer time interval`);
    const nativeMs = clock / NS_PER_MS;
    upper = Math.min(upper, nativeMs - bound.lower);
    if (finite(bound.upper)) lower = Math.max(lower, nativeMs - bound.upper);
  }
  if (!(lower <= upper))
    return unknown(`the Native reads give an empty range [${lower}, ${upper}]`);
  return { range: { lower, upper }, reason: null, reads: clocks.length };
}

/**
 * The seeded fetches' begin calls, in call order, paired with the Native
 * records in seq order. Unaligned (no pairing at all) when the log lost
 * records (mergeNativeRecords) or holds fewer records than begins (a begin
 * without a renderer call, e.g. another consumer, cannot be placed; the
 * strict side). DR-CP4-V-2: records after the paired ones are left out of
 * the pairing, and disclosed (`excludedAfterWindow`), only when the pairs
 * give a consistent clock range and each such record's Native begin started
 * after the observation window closed (`observation.observedUntil`) even at
 * the range's upper end; otherwise the trace stays unaligned. The paired
 * records keep the one-to-one match. DR-CP4-V-3 (レビュー P2-2): a pairing
 * shifted by one gives a consistent range of its own, so the pairs' range
 * must meet the Native reads' (`readClock`, nativeReadClockRange): when
 * M > N always (no read range is unaligned), when M = N whenever the read
 * range is known; the exclusion reads the intersection's upper end.
 */
export function alignSeededBegins({ observation, native, readClock = null }) {
  const fetches = [...(observation?.fetches ?? [])].sort(byCall);
  const begins = [...(observation?.api ?? [])]
    .filter((row) => row.cmd === BEGIN)
    .sort(byCall)
    .filter((row) => typeof ownerOf(fetches, row)?.seed === "string");
  const records = native?.records ?? [];
  const recordOf = new Map();
  const indexOf = new Map();
  let reason = null;
  let excludedAfterWindow = null;
  const reads = readClock?.range ?? null;
  const meet = (bracket) =>
    reads
      ? {
          lower: Math.max(bracket.lower, reads.lower),
          upper: Math.min(bracket.upper, reads.upper),
        }
      : null;
  const consistent = (bracket) =>
    finite(bracket.upper) &&
    finite(bracket.lower) &&
    bracket.lower <= bracket.upper;
  let clock = {
    readClockMs: reads,
    readClockReason: readClock ? readClock.reason : "not given",
    rangeMs: null,
  };
  if (native?.lost === true)
    reason = `the Native log lost records (gaps ${JSON.stringify(native.gaps ?? [])}, front loss ${native.frontLoss === true})`;
  else if (begins.length > records.length)
    reason = `${begins.length} seeded begins, ${records.length} records`;
  else if (begins.length === records.length) {
    if (reads && begins.length > 0) {
      const bracket = clockBracket(begins, records);
      const both = meet(bracket);
      clock = { ...clock, pairsMs: bracket, rangeMs: both };
      if (!consistent(bracket) || !consistent(both))
        reason = `${begins.length} seeded begins, ${records.length} records (the pairs' clock range [${bracket.lower}, ${bracket.upper}] ms does not meet the Native reads' [${reads.lower}, ${reads.upper}] ms)`;
    }
  } else {
    const paired = records.slice(0, begins.length);
    const trailing = records.slice(begins.length);
    const pairs = clockBracket(begins, paired);
    const bracket = meet(pairs) ?? pairs;
    clock = { ...clock, pairsMs: pairs, rangeMs: meet(pairs) };
    const observedUntil = observation?.observedUntil;
    const lowerBoundOf = (record) =>
      finite(record?.tBeginNs)
        ? record.tBeginNs / NS_PER_MS - bracket.upper
        : NaN;
    if (begins.length === 0 || !consistent(pairs))
      reason = `${begins.length} seeded begins, ${records.length} records (the paired begins give no consistent clock range [${pairs.lower}, ${pairs.upper}] ms)`;
    else if (!reads)
      reason = `${begins.length} seeded begins, ${records.length} records (no independent clock range from the Native reads: ${clock.readClockReason})`;
    else if (!consistent(bracket))
      reason = `${begins.length} seeded begins, ${records.length} records (the pairs' clock range [${pairs.lower}, ${pairs.upper}] ms does not meet the Native reads' [${reads.lower}, ${reads.upper}] ms)`;
    else if (!finite(observedUntil))
      reason = `${begins.length} seeded begins, ${records.length} records (the observation has no observedUntil)`;
    else if (!trailing.every((record) => lowerBoundOf(record) > observedUntil))
      reason = `${begins.length} seeded begins, ${records.length} records (the trailing records ${JSON.stringify(trailing.map((record) => record.seq))} are not after the observation window)`;
    else {
      const last = paired.at(-1);
      excludedAfterWindow = {
        rule: "DR-CP4-V-2",
        count: trailing.length,
        records: trailing.map((record) => ({
          seq: record.seq,
          begin: record.begin ?? null,
          reason: record.reason ?? null,
          startSlot: record.startSlot?.kind ?? null,
          afterLastPairedMs: finite(last?.tBeginNs)
            ? (record.tBeginNs - last.tBeginNs) / NS_PER_MS
            : null,
          afterObservedUntilMsAtLeast: lowerBoundOf(record) - observedUntil,
        })),
        lastPairedSeq: last?.seq ?? null,
        observedUntil,
        clockBracketMs: { lower: pairs.lower, upper: pairs.upper },
        // DR-CP4-V-3: the bound the exclusion used (pairs ∩ Native reads).
        clockRangeMs: { lower: bracket.lower, upper: bracket.upper },
      };
    }
  }
  if (reason === null)
    begins.forEach((row, at) => {
      recordOf.set(row.id, records[at]);
      indexOf.set(row.id, at);
    });
  return {
    aligned: reason === null,
    reason,
    seededBegins: begins.length,
    records: records.length,
    excludedAfterWindow,
    clock,
    recordOf,
    indexOf,
  };
}

/** DR-CP4-V-3: the trace's pairing with the Native reads' clock range. */
export function traceAlignment({ observation, native, log }) {
  return alignSeededBegins({
    observation,
    native,
    readClock: nativeReadClockRange({ log, observation, native }),
  });
}

/** The receipt's view of the alignment (DR-CP4-V-2; the maps are not data). */
export function alignmentDisclosure(alignment) {
  return {
    aligned: alignment.aligned,
    reason: alignment.reason,
    seededBegins: alignment.seededBegins,
    records: alignment.records,
    excludedAfterWindow: alignment.excludedAfterWindow,
    clock: alignment.clock ?? null,
  };
}

// ---- the start seal (TR-9) and the maintenance gate (TR-10) ---------------

export const START_SEAL_STATES = Object.freeze([
  "current",
  "dirty",
  "missing",
  "unknown",
]);

/**
 * The rule, fixed before any trace was observed (DR-CP4-TR-9, レビュー P2-1):
 * the B seal is read twice per counted query, `before` (after the operation
 * that starts the query, before the product's query) and `after` (right after
 * the parent fetch was observed, with the A3 record). The query's start seal
 * is `missing` (no B row before) or `dirty` (dirty before) as read before;
 * it is `current` only when both reads are current with the same generation;
 * every other case is `unknown`: a read that failed (busy, timeout, no
 * table) or was not taken, a `before` read that did not finish before the
 * parent fetch was called, an `after` read that did not start after it
 * (renderer clock on both sides), or a seal that changed between the reads.
 * Only `current` puts the query in U; the classifier counts every other state
 * in rule 3 (i), and the receipt counts `unknown` apart (「観測できなかった」).
 */
export function startSealOf(pair, parentCalledAt) {
  const before = pair?.before;
  const after = pair?.after;
  if (!before) return { state: "unknown", reason: "not-read" };
  if (before.read !== "ok")
    return { state: "unknown", reason: `read-failed:${before.error}` };
  if (
    !finite(before.finishedAt) ||
    !finite(parentCalledAt) ||
    !(before.finishedAt < parentCalledAt)
  )
    return { state: "unknown", reason: "read-not-before-query" };
  if (!before.b) return { state: "missing", reason: null };
  if (before.b.dirty)
    return { state: "dirty", reason: null, generation: before.b.generation };
  if (!after) return { state: "unknown", reason: "not-read-after-start" };
  if (after.read !== "ok")
    return {
      state: "unknown",
      reason: `read-after-start-failed:${after.error}`,
    };
  if (!finite(after.startedAt) || !(after.startedAt >= parentCalledAt))
    return { state: "unknown", reason: "read-after-start-not-after-query" };
  if (!after.b || after.b.dirty || after.b.generation !== before.b.generation)
    return { state: "unknown", reason: "changed-around-start" };
  return { state: "current", reason: null, generation: before.b.generation };
}

/** The receipt's count of the start seal states (unknown apart). */
export function startSealCounts(rows) {
  const counts = Object.fromEntries(START_SEAL_STATES.map((name) => [name, 0]));
  for (const row of rows) counts[row.startSeal?.state ?? "unknown"] += 1;
  return counts;
}

/**
 * S2's maintenance gate of a trace run (trace files `maintenance.gate`;
 * observation-prep `B-ROUTE`): CI=true, the owner token (the product source's
 * public constant), a UUIDv4 nonce per launch and the B-ROUTE trigger. The
 * S2 `forbiddenSeamOptions` never enter.
 */
export const TRACE_MAINTENANCE_SEAM = Object.freeze({
  ownerTokenEnv: "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN",
  ownerToken: "c2-5b-product-journey-owner-v1",
  nonceEnv: "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_NONCE",
  triggerEnv: "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER",
  trigger: "nir1-graph-index-build",
});
export const TRACE_MAINTENANCE_FORBIDDEN = Object.freeze([
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_FAULT",
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP",
  "GRIMODEX_PRODUCT_JOURNEY_NARRATIVE_FRESHNESS_HOLD_PROJECT_ID",
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID",
]);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The measurement launch's env (`base`) with the trace's maintenance gate. */
export function traceMaintenanceEnv({ nonce, base }) {
  if (!UUID_V4.test(nonce ?? ""))
    throw new Error("[precheck] the maintenance seam nonce must be a UUIDv4");
  for (const key of TRACE_MAINTENANCE_FORBIDDEN)
    if (Object.hasOwn(base ?? {}, key))
      throw new Error(`[precheck] S2 forbids ${key} in a trace launch`);
  return {
    ...base,
    CI: "true",
    [TRACE_MAINTENANCE_SEAM.ownerTokenEnv]: TRACE_MAINTENANCE_SEAM.ownerToken,
    [TRACE_MAINTENANCE_SEAM.nonceEnv]: nonce,
    [TRACE_MAINTENANCE_SEAM.triggerEnv]: TRACE_MAINTENANCE_SEAM.trigger,
  };
}

// ---- one counted query (TR-3) ----------------------------------------------

/**
 * P2-3 after the fact: the page stays mounted, so the mixing window of a
 * child is settled when every Graph continue issued from the parent up to the
 * next fetch after the child returned and the child's `t_raw_ready` + W_f
 * (the product child window when longer) plus the commit margin lies inside
 * what was observed.
 */
export function mixWindowAfter({ observation, parent, child, observedUntil }) {
  if (!child || child.resolvedAt === null || child.resolvedAt === undefined)
    return { reason: "not-applied", until: null };
  const next = (observation.fetches ?? [])
    .filter((row) => row.seq > child.seq)
    .sort(byCall)[0];
  const continues = (observation.api ?? []).filter(
    (row) =>
      row.cmd === GRAPH_CONTINUE &&
      row.calledAt >= parent.calledAt &&
      (next === undefined || row.calledAt < next.calledAt),
  );
  if (!continues.every((row) => finite(row.resolvedAt)))
    return { reason: "harness-limit", until: observedUntil ?? null };
  const rawReady = child.result?.timing?.tRawReadyMs;
  const windowMs = Math.max(
    K64_W_F_MS,
    child.result?.timing?.graphWindowMs ?? 0,
  );
  const until =
    Math.max(
      ...continues.map((row) => row.resolvedAt),
      finite(rawReady) ? rawReady + windowMs : -Infinity,
    ) + MIX_COMMIT_MARGIN_MS;
  return finite(observedUntil) && until <= observedUntil
    ? { reason: "settled", until }
    : { reason: "harness-limit", until: observedUntil ?? null };
}

/** The disclosure of the two start seal reads of one counted query. */
function startSealReads(startSeal) {
  return Object.fromEntries(
    ["before", "after"].map((phase) => [
      phase,
      startSeal?.[phase]
        ? {
            read: startSeal[phase].read,
            b: startSeal[phase].b ?? null,
            chronicle: startSeal[phase].chronicle ?? null,
            startedAt: startSeal[phase].startedAt ?? null,
            finishedAt: startSeal[phase].finishedAt ?? null,
            durationMs: startSeal[phase].durationMs ?? null,
          }
        : null,
    ]),
  );
}

export const CANCELLED_BEFORE_BEGIN = "cancelled-before-begin";

/**
 * DR-CP4-V-3 (rule P-b, integrator 2026-10-31): the row of a counted parent
 * the product cancelled before its begin, or null when the parent is not that
 * case (the caller keeps the defect row). The case is exactly: the fetch
 * returned `status: cancelled` with `rawStatus: not-started`, no begin call
 * of the observation belongs to it, none of its generation's displays was
 * committed, and its start-time A3 read exists (the caller checked the
 * alignment). The parent is in Q (K6/2 rule 1), not in U (no begin answer,
 * so the snapshot is not usable; `lapseKind` counts it in (i)), and K6/4
 * X12 (followup.mjs). `tRawReady` holds the parent's return (disclosed in
 * `tRawReadyBasis`): `classifyJoin` needs the three renderer times, and a
 * query that joined nothing is never in the window, so the value enters no
 * count. The re-query the product issued after it stays outside Q.
 */
function cancelledParentRow({
  queryId,
  index,
  parent,
  all,
  observation,
  fetches,
  logEntry,
  a3,
  startSeal,
  d2aMode,
  materials,
  windowEnd,
}) {
  const result = parent.result;
  if (result?.status !== "cancelled" || result?.rawStatus !== "not-started")
    return null;
  const beganBy = (fetch) =>
    (observation.api ?? []).some(
      (row) => row.cmd === BEGIN && ownerOf(all, row)?.seq === fetch.seq,
    );
  if (beganBy(parent)) return null;
  if ((observation.commits ?? []).some((row) => row.fetchSeq === parent.seq))
    return null;
  if (!a3 || !Array.isArray(a3.revisions)) return null;
  const tFetch = result.timing?.tFetchMs ?? parent.calledAt;
  const tReturn = result.timing?.tReturnMs ?? parent.resolvedAt;
  if (!finite(tFetch) || !finite(tReturn) || !(tFetch <= tReturn)) return null;
  if (!finite(parent.calledAt) || !finite(parent.resolvedAt)) return null;
  const seal = startSealOf(startSeal, parent.calledAt);
  const requery = fetches.find((row) => row.seq !== parent.seq) ?? null;
  const indexReady = (observation.notices ?? [])
    .filter((row) => row.kind === "index-ready" && row.at <= parent.calledAt)
    .sort((left, right) => left.at - right.at)
    .at(-1);
  return {
    queryId,
    trigger: "user-operation",
    seeded: true,
    graphEnabled: true,
    d2aMode,
    expectedMaterials: materials,
    traceIndex: index,
    tFetch,
    tRawReady: tReturn,
    tRawReadyBasis: "t-return:raw-not-started",
    tReturn,
    status: "cancelled",
    rawStatus: "not-started",
    irOutcome: "not-started",
    irCompletion: null,
    rawSceneIds: result.rawSceneIds ?? [],
    finalSceneIds: result.finalSceneIds ?? [],
    snapshot: {
      usable: false,
      reason: `no-native-begin:${CANCELLED_BEFORE_BEGIN}`,
      chronicleIndexUsable: null,
      source: "start-seal",
    },
    snapshotNative: null,
    a3AtStart: a3AtStartOf(a3),
    startSeal: { ...seal, reads: startSealReads(startSeal) },
    graph: {
      outcome: "cancelled",
      reason: CANCELLED_BEFORE_BEGIN,
      source: null,
      joined: false,
      arrivedAt: null,
      revalidation: null,
      edgeCount: null,
      busyCause: null,
    },
    nativeBegin: null,
    cycleEnd: logEntry.cycleEnd ?? null,
    followUp: {
      issuedVia: PRODUCT_HOOK,
      parent: {
        generation: 1,
        queryGeneration: parent.queryGeneration ?? null,
        sceneId: parent.sceneId,
        seed: parent.seed,
        calledAt: parent.calledAt,
        resolvedAt: parent.resolvedAt,
        publishCount: 0,
        cancelledBeforeBegin: true,
      },
      nativeBegins: [],
      child: null,
      requerySeq: requery?.seq ?? null,
    },
    cancelledBeforeBegin: {
      rule: "DR-CP4-V-3",
      parentSeq: parent.seq,
      calledAt: parent.calledAt,
      resolvedAt: parent.resolvedAt,
      indexReadyAt: indexReady?.at ?? null,
      afterIndexReadyMs: indexReady ? parent.calledAt - indexReady.at : null,
      startSeal: seal.state,
      requery: requery
        ? {
            seq: requery.seq,
            calledAt: requery.calledAt,
            began: beganBy(requery),
          }
        : null,
      // No re-query of the Scene in this query's window: it came after the
      // window (the next parent's call, a move, or the observation's end).
      requeryOutsideWindow: requery === null,
      windowEnd: finite(windowEnd) ? windowEnd : null,
      observedUntil: observation.observedUntil ?? null,
    },
  };
}

/** A row that cannot carry its R7 record (summarizeTrace makes the trace invalid). */
function defectRow({ queryId, d2aMode, materials, parent, error }) {
  return {
    queryId,
    trigger: "user-operation",
    seeded: true,
    graphEnabled: true,
    d2aMode,
    expectedMaterials: materials,
    tFetch: parent?.calledAt ?? null,
    followUp: null,
    startSeal: { state: "unknown", reason: "row-defect" },
    rowError: error,
  };
}

/**
 * The row of counted query `index` (its parent fetch is `logEntry.parentSeq`,
 * its cycle end `logEntry.cycleEnd`). Throws `[precheck]` when the product
 * sent no seed (R5).
 */
export function traceQueryRow({
  plan,
  index,
  logEntry,
  nextParentSeq,
  observation,
  alignment,
  native,
  runs,
  a3,
  startSeal = null,
  d2aMode,
  materials,
  expectedContribution,
  materialContribution = null,
}) {
  const queryId = `${plan.traceId}#${index}`;
  const all = [...(observation.fetches ?? [])].sort(byCall);
  const parent = all.find((row) => row.seq === logEntry.parentSeq);
  if (!parent)
    return defectRow({
      queryId,
      d2aMode,
      materials,
      parent,
      error: `the parent fetch ${logEntry.parentSeq} was not observed`,
    });
  if (typeof parent.seed !== "string")
    throw new Error(
      `[precheck] R5: the product hook sent no seed for counted query ${queryId} (the query Scene's first pin)`,
    );
  const nextParent =
    nextParentSeq === null
      ? null
      : (all.find((row) => row.seq === nextParentSeq) ?? null);
  // レビュー P1-1: the window ends at the next parent's call or at the first
  // navigation after this query, whichever is earlier, and holds only the
  // query Scene's fetches, their API rows and the commits that showed them
  // (a Scene without a pin is outside Q and never this query's child).
  const windowEnd = Math.min(
    nextParent?.calledAt ?? Infinity,
    finite(logEntry.windowEndAt) ? logEntry.windowEndAt : Infinity,
  );
  const inWindow = (at) => at >= parent.calledAt && at < windowEnd;
  const sameScene = (fetch) => fetch?.sceneId === parent.sceneId;
  const fetches = all.filter((row) => inWindow(row.calledAt) && sameScene(row));
  const api = (observation.api ?? []).filter(
    (row) => inWindow(row.calledAt) && sameScene(ownerOf(all, row)),
  );
  const generationScene = (commit) =>
    commit.fetchSeq === null || commit.fetchSeq === -1
      ? ownerOf(all, { calledAt: commit.at })
      : all.find((row) => row.seq === commit.fetchSeq);
  const child = fetches[1] ?? null;
  // The mixing is observed until the next parent of the Scene: after a move
  // the display shows another Scene, so no commit of this Scene's
  // generations can follow (DR-CP4-TR-13).
  const observedUntil = Math.min(
    nextParent?.calledAt ?? Infinity,
    observation.observedUntil,
  );
  const window = {
    endReason: logEntry.cycleEnd?.reason ?? null,
    mountedAt: parent.calledAt,
    endedAt: logEntry.cycleEnd?.at ?? null,
    mixWindow: mixWindowAfter({
      observation: { fetches, api },
      parent,
      child,
      observedUntil,
    }),
    fetches,
    // 再レビュー P2: the commits stay until the next parent's call even after
    // a move: whether the Scene's generations show anything after the move is
    // what the mixing checks observe (N1, N29, N32), not an assumption.
    commits: (observation.commits ?? []).filter(
      (row) =>
        row.at >= parent.calledAt &&
        row.at < observedUntil &&
        sameScene(generationScene(row)),
    ),
    notices: (observation.notices ?? []).filter((row) => inWindow(row.at)),
    api,
  };
  if (!alignment.aligned)
    return defectRow({
      queryId,
      d2aMode,
      materials,
      parent,
      error: `the Native records are not aligned: ${alignment.reason}`,
    });
  const windowBegins = [...api].filter((row) => row.cmd === BEGIN).sort(byCall);
  const nativeRecords = windowBegins.map(
    (row) =>
      alignment.recordOf.get(row.id) ?? { seq: null, begin: "no-record" },
  );
  const beginOf = (fetch) =>
    fetch
      ? windowBegins.find((row) => ownerOf(fetches, row)?.seq === fetch.seq)
      : undefined;
  const parentBegin = beginOf(parent);
  const childBegin = beginOf(child);
  const parentRecord = parentBegin
    ? alignment.recordOf.get(parentBegin.id)
    : undefined;
  const childRecord = childBegin
    ? alignment.recordOf.get(childBegin.id)
    : undefined;
  if (!parentRecord) {
    // DR-CP4-V-3: a parent cancelled before its begin has no begin call and
    // no Native record; every other parent without a record is a defect.
    const cancelled = parentBegin
      ? null
      : cancelledParentRow({
          queryId,
          index,
          parent,
          all,
          observation,
          fetches,
          logEntry,
          a3,
          startSeal,
          d2aMode,
          materials,
          windowEnd: Math.min(windowEnd, observation.observedUntil ?? Infinity),
        });
    if (cancelled) return cancelled;
    return defectRow({
      queryId,
      d2aMode,
      materials,
      parent,
      error: "the parent's begin has no Native record",
    });
  }
  const endRecord = childRecord ?? parentRecord;
  const boundary = boundaryCounters(runs, {
    beginNs: parentRecord.tBeginNs,
    endNs: endRecord.tReturnedNs,
  });
  let row;
  try {
    row = k64GraphSampleRow({
      variantKey: plan.traceId,
      phase: "trace",
      repeat: index,
      d2aMode,
      observation: window,
      nativeRecords,
      a3,
      r1: null,
      counters: boundary
        ? { before: boundary.before, atEnd: boundary.after }
        : { before: {}, atEnd: {} },
      expectedContribution,
      // DR-CP4-V-2: the formal trace matches F6 on the materials' Revisions
      // (DR-CP4-N-4); the dev preview keeps the Scene-level match.
      ...(typeof materialContribution === "function"
        ? { materialContribution }
        : {}),
    });
  } catch (error) {
    // レビュー P3 (e): a parent that returned no result (or any record the
    // producer refuses) is this query's defect; the receipt is kept.
    if (String(error?.message).startsWith("[precheck] R5")) throw error;
    return defectRow({
      queryId,
      d2aMode,
      materials,
      parent,
      error: `the R7 record could not be built: ${error?.message ?? error}`,
    });
  }
  const records = native.records;
  const from = records.indexOf(parentRecord);
  const to = childRecord ? records.indexOf(childRecord) : from;
  const followUp = { ...row.followUp };
  delete followUp.r1;
  delete followUp.r2;
  delete followUp.countersAfterRelease;
  if (!boundary) followUp.counters = { before: null, after: null };
  followUp.nativeBegins = records
    .slice(from, to + 1)
    .map((record) => record.begin);
  followUp.boundary = boundary
    ? {
        read: boundary.read,
        beforeGapNs: boundary.beforeGapNs,
        afterGapNs: boundary.afterGapNs,
        fromSeq: parentRecord.seq,
        toSeq: endRecord.seq,
      }
    : { read: "missing" };
  // TR-9: U and rule 3 (i) read the start seal; the begin's own answer (D′
  // always answers `pending`) stays as `snapshotNative` for disclosure.
  const seal = startSealOf(startSeal, parent.calledAt);
  const snapshot = {
    usable: row.snapshot.usable === true && seal.state === "current",
    reason:
      seal.state === "current"
        ? row.snapshot.reason
        : `start-seal:${seal.state}`,
    chronicleIndexUsable: row.snapshot.chronicleIndexUsable,
    source: "start-seal",
  };
  return {
    ...row,
    snapshot,
    snapshotNative: row.snapshot,
    startSeal: { ...seal, reads: startSealReads(startSeal) },
    queryId,
    trigger: "user-operation",
    expectedMaterials: materials,
    traceIndex: index,
    cycleEnd: logEntry.cycleEnd ?? null,
    followUp,
  };
}

/** Every counted query's row, in the plan's order. */
export function traceRows({
  plan,
  observation,
  log,
  native,
  runs,
  a3Reads,
  startSeals = {},
  d2aMode,
  ids,
  expectedContribution,
  materialContribution = null,
}) {
  const materials = plan.expectedMaterials.map((row) => {
    const runtime = ids?.revisions?.[row.revisionId];
    if (typeof runtime !== "string")
      throw new Error(
        `[precheck] the expected material ${row.revisionId} has no runtime ID in the setup receipt`,
      );
    return runtime;
  });
  const counted = log.filter((row) => Number.isInteger(row.parentSeq));
  const alignment = traceAlignment({ observation, native, log });
  // レビュー P1-1: the first move after each counted query ends its window.
  const moveAfter = (entry) =>
    log.slice(log.indexOf(entry) + 1).find((row) => row.op === "navigate")
      ?.at ?? null;
  return counted.map((entry, at) =>
    traceQueryRow({
      plan,
      index: entry.index ?? at,
      logEntry: { ...entry, windowEndAt: moveAfter(entry) },
      nextParentSeq: counted[at + 1]?.parentSeq ?? null,
      observation,
      alignment,
      native,
      runs,
      a3: a3Reads?.[entry.parentSeq] ?? null,
      startSeal: startSeals?.[entry.index ?? at] ?? null,
      d2aMode,
      materials,
      expectedContribution,
      materialContribution,
    }),
  );
}

/**
 * DR-CP4-V-2: the formal trace's F6 resolver (material-revision.mjs, built
 * from the G-02 base setup plan as Gold builds it) must expect exactly the
 * trace file's materials: the same (Revision, edge) pairs. `[precheck]`
 * otherwise (the trace file and the fixture would disagree on F6).
 */
export function assertTraceMaterialsMatch({ plan, expected }) {
  const fromPlan = new Set(
    (plan?.expectedMaterials ?? []).flatMap((row) =>
      (row.edgeIds ?? []).map((edgeId) => `${row.revisionId}|${edgeId}`),
    ),
  );
  const fromResolver = new Set(
    (expected ?? []).flatMap((row) => row.pairs ?? []),
  );
  const same =
    fromPlan.size > 0 &&
    fromPlan.size === fromResolver.size &&
    [...fromPlan].every((pair) => fromResolver.has(pair));
  if (!same)
    throw new Error(
      `[precheck] DR-CP4-V-2: the F6 resolver expects ${JSON.stringify([...fromResolver].sort())}, the trace file's materials are ${JSON.stringify([...fromPlan].sort())}`,
    );
  return [...fromPlan].sort();
}

// ---- re-queries, outside Q and events --------------------------------------

/** The hook's IR-timeout retry runs after a published IR timeout. */
function irRetried(result) {
  return (
    result?.resultKind === "raw" &&
    result?.irStatus === "unavailable" &&
    result?.irReason === "timeout"
  );
}

/**
 * Every fetch that is not a counted parent: `outside-q` (no seed, or not the
 * query Scene when `querySceneId` is given), or a
 * re-query by what started it (K6/2 step 7: counted apart, never in a
 * denominator): the hook's `graph-ready` mark, an `index-ready` notice since
 * the previous fetch of the Scene, the previous fetch's IR-timeout retry, else
 * unattributed. DR-CP4-V-3: when the previous fetch of the Scene is a counted
 * parent cancelled before its begin (`cancelledParentSeqs`), the notice is
 * looked for since the Scene's fetch before it that reached its begin (the
 * attribution only; the re-query stays outside Q).
 */
export function traceRequeries({
  observation,
  parentSeqs,
  querySceneId,
  cancelledParentSeqs = [],
}) {
  const parents = new Set(parentSeqs);
  const cancelled = new Set(cancelledParentSeqs);
  const fetches = [...(observation.fetches ?? [])].sort(byCall);
  const began = new Set(
    (observation.api ?? [])
      .filter((row) => row.cmd === BEGIN)
      .map((row) => ownerOf(fetches, row)?.seq),
  );
  const counts = {
    "graph-ready": 0,
    "index-ready": 0,
    "ir-retry": 0,
    unattributed: 0,
    "outside-q": 0,
  };
  const rows = [];
  fetches.forEach((fetch, at) => {
    if (parents.has(fetch.seq)) return;
    let kind;
    // レビュー P3 (a): outside Q is no seed or another Scene than the query's.
    if (
      typeof fetch.seed !== "string" ||
      (querySceneId !== undefined && fetch.sceneId !== querySceneId)
    )
      kind = "outside-q";
    else if (fetch.refreshTrigger === "graph-ready") kind = "graph-ready";
    else {
      const previous = fetches
        .slice(0, at)
        .findLast((row) => row.sceneId === fetch.sceneId);
      const from = cancelled.has(previous?.seq)
        ? fetches
            .slice(0, at)
            .findLast(
              (row) =>
                row.sceneId === fetch.sceneId &&
                row.calledAt < previous.calledAt &&
                began.has(row.seq),
            )
        : previous;
      const since = from?.calledAt ?? -Infinity;
      if (
        (observation.notices ?? []).some(
          (row) =>
            row.kind === "index-ready" &&
            row.at >= since &&
            row.at <= fetch.calledAt,
        )
      )
        kind = "index-ready";
      else if (irRetried(previous?.result)) kind = "ir-retry";
      else kind = "unattributed";
    }
    counts[kind] += 1;
    rows.push({ seq: fetch.seq, kind, calledAt: fetch.calledAt });
  });
  return { counts, rows };
}

/**
 * The event stream `validateTraceEvents` reads (K6/2 step 4 density): the
 * runner's operations (`harness-caret`, `edit` via the product editor,
 * `navigate`, any `harness-*` wait), the autosave commits the page observed
 * and every fetch (`user-operation` for a counted parent, `outside-q` without
 * a seed, else `<kind>-requery`), in renderer time order.
 */
export function traceEvents({
  plan,
  observation,
  log,
  parentSeqs,
  querySceneId = plan.querySceneId,
  cancelledParentSeqs = [],
}) {
  const events = [];
  for (const entry of log) {
    if (entry.op === "edit") {
      events.push({ type: "harness-caret", at: entry.caretAt });
      events.push({
        type: "edit",
        via: "product-editor",
        action: entry.action ?? null,
        at: entry.endedAt,
      });
    } else if (entry.op === "navigate")
      events.push({ type: "navigate", sceneId: entry.sceneId, at: entry.at });
    else if (entry.op === "seal-read")
      // レビュー P2-1: a read-only record read (DR-CP4-TR-13), kept in the
      // stream; validateTraceEvents treats it as neither an operation nor a
      // harness wait.
      events.push({ type: "seal-read", phase: entry.phase, at: entry.at });
    else if (typeof entry.op === "string" && entry.op.startsWith("harness-"))
      events.push({ type: entry.op, at: entry.at });
  }
  let version = observation.initialVersion ?? null;
  for (const commit of [...(observation.bodyCommits ?? [])].sort(
    (left, right) => left.at - right.at,
  )) {
    if (commit.sceneId !== querySceneId) continue;
    events.push({
      type: "autosave-commit",
      sceneId: commit.sceneId,
      versionBefore: version,
      versionAfter: commit.contentVersion,
      at: commit.at,
    });
    version = commit.contentVersion;
  }
  const requeries = new Map(
    traceRequeries({
      observation,
      parentSeqs,
      querySceneId,
      cancelledParentSeqs,
    }).rows.map((row) => [row.seq, row.kind]),
  );
  const parents = new Set(parentSeqs);
  for (const fetch of observation.fetches ?? []) {
    const kind = requeries.get(fetch.seq);
    events.push({
      type: "query",
      seq: fetch.seq,
      trigger: parents.has(fetch.seq)
        ? "user-operation"
        : kind === "outside-q"
          ? "outside-q"
          : `${kind}-requery`,
      issuedBy: "product",
      at: fetch.calledAt,
    });
  }
  // Stable: an operation before an observation at the same time.
  return events
    .map((event, order) => ({ event, order }))
    .sort(
      (left, right) =>
        left.event.at - right.event.at || left.order - right.order,
    )
    .map(({ event }) => event);
}

/**
 * The trace's checks and its (b) summary. `defects` (a retake, the trace's
 * K6/2 rule 1 「trace の不備」) are the density errors and a count of counted
 * queries different from the plan or the events. `candidate` / `candidateHead`
 * are passed to `summarizeTrace` as they are (a K6/4-era run).
 */
export function summarizeTraceRun({
  plan,
  rows,
  events,
  fixedGraphMode,
  stalled = null,
  ...rest
}) {
  const check = validateTraceEvents(plan.kind, events);
  const defects = [...check.errors];
  if (check.queries !== rows.length)
    defects.push(
      `the events hold ${check.queries} counted queries, the rows ${rows.length}`,
    );
  if (rows.length !== plan.plannedQ)
    defects.push(
      `${rows.length} counted queries, the plan has ${plan.plannedQ}`,
    );
  const summary = summarizeTrace({
    trace: { kind: plan.kind, queries: rows },
    fixedGraphMode,
    ...(Object.hasOwn(rest, "candidate")
      ? { candidate: rest.candidate, candidateHead: rest.candidateHead }
      : {}),
  });
  // レビュー P2-2: a stalled attempt or a defective trace is never valid,
  // whatever its Q (a run cut at 200 of 201 planned queries must not pass).
  const statusReasons = [
    ...(stalled ? [`trace-stalled:${stalled.reason}`] : []),
    ...defects.map((row) => `trace-defect:${row}`),
  ];
  const status =
    statusReasons.length === 0 && summary.status === "valid"
      ? "valid"
      : "invalid";
  return {
    status,
    statusReasons,
    events: check,
    defects,
    summary:
      statusReasons.length === 0
        ? summary
        : {
            ...summary,
            status: "invalid",
            invalid: [...(summary.invalid ?? []), ...statusReasons],
          },
  };
}

/** DR-CP4-V-3: the parent seqs of the counted parents cancelled before begin. */
export function cancelledParentSeqsOf(rows) {
  return rows
    .filter((row) => row.cancelledBeforeBegin)
    .map((row) => row.cancelledBeforeBegin.parentSeq);
}

/** DR-CP4-V-3: the receipt's disclosure of the cancelled parents. */
export function cancelledParentsDisclosure(rows) {
  const cancelled = rows.filter((row) => row.cancelledBeforeBegin);
  return {
    rule: "DR-CP4-V-3",
    count: cancelled.length,
    rows: cancelled.map((row) => ({
      queryId: row.queryId,
      ...row.cancelledBeforeBegin,
    })),
  };
}

/**
 * DR-CP4-V-3: rule 3 (i) of one summary, with the parents cancelled before
 * their begin apart (null when the summary has no lapse count).
 */
export function lapseIBreakdown(summary, rows) {
  const total = summary?.lapse?.["i-b-seal"];
  if (!Number.isInteger(total)) return null;
  const cancelled = rows.filter((row) => row.cancelledBeforeBegin).length;
  return {
    "i-b-seal": total,
    cancelledBeforeBegin: cancelled,
    other: total - cancelled,
    "i-chronicle-stop": summary.lapse["i-chronicle-stop"] ?? null,
  };
}

/** A trace receipt's identity block of the plan. */
export function tracePlanIdentity(loaded) {
  if (!SHA256_HEX.test(loaded?.sha256 ?? ""))
    throw new Error("[artifact] the trace plan lacks its sha256");
  return {
    traceId: loaded.plan.traceId,
    kind: loaded.plan.kind,
    path: loaded.path,
    sha256: loaded.sha256,
    commit: loaded.commit,
    status: loaded.plan.status ?? null,
    plannedQ: loaded.plan.plannedQ,
  };
}
