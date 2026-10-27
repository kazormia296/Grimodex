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
import { finite } from "./join.mjs";
import { k64GraphSampleRow } from "./k64-record.mjs";
import { BEGIN, GRAPH_CONTINUE } from "./run-sample.mjs";

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
 * Merges `nir1GraphEvalSamples` reads taken during the trace (the log is not
 * cleared during it): one record per seq, the later read's state (a ticket
 * settles later), the largest `dropped`.
 */
export function mergeNativeRecords(reads) {
  const bySeq = new Map();
  let dropped = 0;
  for (const read of reads) {
    dropped = Math.max(dropped, read?.dropped ?? 0);
    for (const record of read?.records ?? []) bySeq.set(record.seq, record);
  }
  return {
    dropped,
    records: [...bySeq.values()].sort((left, right) => left.seq - right.seq),
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

/**
 * The seeded fetches' begin calls, in call order, paired with the Native
 * records in seq order. Unaligned (no pairing at all) when the counts differ
 * or the log dropped records (a begin without a renderer call, e.g. another
 * consumer, cannot be placed; the strict side).
 */
export function alignSeededBegins({ observation, native }) {
  const fetches = [...(observation?.fetches ?? [])].sort(byCall);
  const begins = [...(observation?.api ?? [])]
    .filter((row) => row.cmd === BEGIN)
    .sort(byCall)
    .filter((row) => typeof ownerOf(fetches, row)?.seed === "string");
  const records = native?.records ?? [];
  const recordOf = new Map();
  const indexOf = new Map();
  let reason = null;
  if ((native?.dropped ?? 0) > 0)
    reason = `the Native log dropped ${native.dropped} records`;
  else if (begins.length !== records.length)
    reason = `${begins.length} seeded begins, ${records.length} records`;
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
    recordOf,
    indexOf,
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
  d2aMode,
  materials,
  expectedContribution,
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
  const windowEnd = nextParent?.calledAt ?? Infinity;
  const inWindow = (at) => at >= parent.calledAt && at < windowEnd;
  const fetches = all.filter((row) => inWindow(row.calledAt));
  const api = (observation.api ?? []).filter((row) => inWindow(row.calledAt));
  const child = fetches[1] ?? null;
  const observedUntil = Math.min(windowEnd, observation.observedUntil);
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
    commits: (observation.commits ?? []).filter((row) => inWindow(row.at)),
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
  if (!parentRecord)
    return defectRow({
      queryId,
      d2aMode,
      materials,
      parent,
      error: "the parent's begin has no Native record",
    });
  const endRecord = childRecord ?? parentRecord;
  const boundary = boundaryCounters(runs, {
    beginNs: parentRecord.tBeginNs,
    endNs: endRecord.tReturnedNs,
  });
  const row = k64GraphSampleRow({
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
  });
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
  return {
    ...row,
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
  d2aMode,
  ids,
  expectedContribution,
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
  const alignment = alignSeededBegins({ observation, native });
  return counted.map((entry, at) =>
    traceQueryRow({
      plan,
      index: entry.index ?? at,
      logEntry: entry,
      nextParentSeq: counted[at + 1]?.parentSeq ?? null,
      observation,
      alignment,
      native,
      runs,
      a3: a3Reads?.[entry.parentSeq] ?? null,
      d2aMode,
      materials,
      expectedContribution,
    }),
  );
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
 * Every fetch that is not a counted parent: `outside-q` (no seed), or a
 * re-query by what started it (K6/2 step 7: counted apart, never in a
 * denominator): the hook's `graph-ready` mark, an `index-ready` notice since
 * the previous fetch of the Scene, the previous fetch's IR-timeout retry, else
 * unattributed.
 */
export function traceRequeries({ observation, parentSeqs }) {
  const parents = new Set(parentSeqs);
  const fetches = [...(observation.fetches ?? [])].sort(byCall);
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
    if (typeof fetch.seed !== "string") kind = "outside-q";
    else if (fetch.refreshTrigger === "graph-ready") kind = "graph-ready";
    else {
      const previous = fetches
        .slice(0, at)
        .findLast((row) => row.sceneId === fetch.sceneId);
      const since = previous?.calledAt ?? -Infinity;
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
export function traceEvents({ plan, observation, log, parentSeqs }) {
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
    else if (typeof entry.op === "string" && entry.op.startsWith("harness-"))
      events.push({ type: entry.op, at: entry.at });
  }
  let version = observation.initialVersion ?? null;
  for (const commit of [...(observation.bodyCommits ?? [])].sort(
    (left, right) => left.at - right.at,
  )) {
    if (commit.sceneId !== plan.querySceneId) continue;
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
    traceRequeries({ observation, parentSeqs }).rows.map((row) => [
      row.seq,
      row.kind,
    ]),
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
  return { events: check, defects, summary };
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
