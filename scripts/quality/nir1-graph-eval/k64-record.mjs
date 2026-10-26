// CP-4 S1f: K6/4 の R7 の記録の producer（純粋な部分）。
//
// 入力は、製品の `useNir1RelatedScenes` を mount した hook の消費者
// （`renderer/cp4-k64-probe.tsx`。R5）が 1 sample で観測したものと、Native の評価
// 記録（`nir1GraphEvalSamples`）、owner の counter（`nir1GraphEvalDiagnostics`）、
// R1／R2 の状態。出力は S1b の sample の行（親の欄は run-sample.mjs の `sampleRow`
// のまま）に、分類器（followup.mjs）が読む `followUp`（test-support.mjs の
// `followUpRecord` の形）を足したもの。この module は Electron も Native も見ない。
//
// 時計（R6）: `t_raw_ready`、`t_pub_p`、`t_notice`、`t_raw_ready_c`、`t_graph_c`、
// `t_follow` と React の commit は renderer の同じ `performance.now()`。Native の
// ns は開示（q4）と順序だけに使い、renderer の ms と混ぜない。
//
// 観測（observation、1 sample）:
//   endReason, mountedAt, endedAt
//   fetches[]  製品の `fetchRelatedPastScenes` の呼出し（hook が出したもの。
//              `fetchRelatedScenes.timing.ts`）: seq, sceneId, queryGeneration,
//              refreshTrigger（hook が渡した印）, seed（hook が pin から読んで渡した
//              seed）, rawOnly, calledAt, resolvedAt, result（返った結果の要約。
//              返らなければ null）
//   commits[]  probe の useLayoutEffect（React の commit）: at, fetchSeq（表示中の
//              結果の seq。null は表示なし）, loading, display（表示の内容の鍵）
//   notices[]  その project の `graph-ready`／`index-ready` の受信: kind, at
//   api[]      wrapper の層の呼出し（`nir1RelatedScenesApi.timing.ts`）: cmd,
//              calledAt, resolvedAt, settle, status, reason
// 親は最初の fetch、子は親の次の fetch（「親の次の世代」。契機は観測で確かめる）。

import {
  BOUNDARY_TOLERANCE_MS,
  GRAPH_EVAL_D_MS,
  K64_W_F_MS,
  OWNER_REBUILD_MIN_INTERVAL_MS,
} from "./constants.mjs";
import { PRODUCT_HOOK } from "./followup.mjs";
import { finite } from "./join.mjs";
import { isNativeNs } from "./native-sample.mjs";
import { BEGIN, GRAPH_CONTINUE, sampleRow } from "./run-sample.mjs";
import { distribution } from "./stats.mjs";

export const IR_CONTINUE = "related_scenes_continue";
/** The receipt's runner kind of this producer (receipt.mjs RUNNER_KINDS). */
export const K64_RUNNER_KIND = "k64-hook-consumer";
export const SAMPLE_END_REASONS = Object.freeze([
  "child-published",
  "child-ended",
  "t-show-elapsed",
  "parent-ended",
  "session-stopped",
]);
const COUNTER_KEYS = Object.freeze(["begins", "cacheHits", "lateCached"]);
const DPRIME_COUNTER_KEYS = Object.freeze([
  "deferredReleased",
  "deferredExpired",
  "deferredDropped",
  "staleReadyRetired",
  "prepareFailures",
  "driftAtQuery",
  "stamp0Missing",
]);

/**
 * R1 (K6/4:192) observed by the harness just before the query: (1) the slot
 * is `empty`, (2) the next-query cache is empty (cleared through the test
 * entry), (3) at least `rebuild_min_interval` since the previous seeded
 * sample ended (null: no previous seeded sample), (4) the previous sample's
 * R4 release wait ended within the procedure file's bound. `reachedQuiet` is
 * computed from the four, never taken from the caller.
 */
export function r1Record({
  slot,
  cacheOccupied,
  cacheCleared,
  sinceLastSeededMs,
  previousReleaseWithinLimit,
  waitedMs,
}) {
  const slotEmpty = slot === "empty";
  const cacheEmpty = cacheOccupied === false;
  const interval =
    sinceLastSeededMs === null ||
    (finite(sinceLastSeededMs) &&
      sinceLastSeededMs >= OWNER_REBUILD_MIN_INTERVAL_MS);
  return {
    slot: slot ?? null,
    slotEmpty,
    cacheEmpty,
    sinceLastSeededMs,
    previousReleaseWithinLimit: previousReleaseWithinLimit === true,
    reachedQuiet:
      slotEmpty &&
      cacheEmpty &&
      interval &&
      previousReleaseWithinLimit === true,
    waitedMs,
    cacheCleared,
  };
}

/** R2 (K6/4:193): the cache at the sample's end (emptied when it was not). */
export function r2Record({ cacheOccupiedAtEnd, cleared }) {
  return {
    cacheEmptyAtEnd: cacheOccupiedAtEnd === false,
    clearedAtEnd: cleared,
  };
}

const pick = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, value?.[key]]));

function nsToMs(start, end) {
  return isNativeNs(start) && isNativeNs(end) && end >= start
    ? (end - start) / 1e6
    : null;
}

/** The sample's fetches, the API rows each one issued and the begin order. */
function viewOf(observation) {
  const fetches = [...(observation?.fetches ?? [])].sort(
    (left, right) => left.seq - right.seq,
  );
  const api = [...(observation?.api ?? [])].sort(
    (left, right) => left.calledAt - right.calledAt,
  );
  // A row belongs to the latest fetch that started at or before it (a
  // fetch's own calls come after its start).
  const owner = (row) =>
    fetches.filter((fetch) => fetch.calledAt <= row.calledAt).at(-1)?.seq ??
    null;
  const rowsOf = (fetch) =>
    fetch ? api.filter((row) => owner(row) === fetch.seq) : [];
  const begins = api.filter((row) => row.cmd === BEGIN);
  return {
    fetches,
    parent: fetches[0] ?? null,
    child: fetches[1] ?? null,
    api,
    rowsOf,
    begins,
    commits: [...(observation?.commits ?? [])].sort(
      (left, right) => left.at - right.at,
    ),
    notices: [...(observation?.notices ?? [])].sort(
      (left, right) => left.at - right.at,
    ),
  };
}

/** The renderer arrival of an available Graph answer of a fetch. */
function graphArrivalOf(rows) {
  const row = rows.find(
    (entry) => entry.cmd === GRAPH_CONTINUE && entry.settle === null,
  );
  return row?.status === "available" && finite(row.resolvedAt)
    ? row.resolvedAt
    : null;
}

function continueAnswerOf(rows) {
  const row = rows.find(
    (entry) => entry.cmd === GRAPH_CONTINUE && entry.settle === null,
  );
  if (!row || !finite(row.resolvedAt)) return null;
  return row.status === "available" ? "available" : (row.reason ?? row.status);
}

function settleOf(rows) {
  return (
    rows.find(
      (entry) => entry.cmd === GRAPH_CONTINUE && entry.settle !== null,
    ) ?? null
  );
}

/** The Native record of a fetch's first begin (records pair with begins in order). */
function recordOf(view, fetch, records, aligned) {
  const begin = view.rowsOf(fetch).find((row) => row.cmd === BEGIN);
  if (!begin) return { begin: null, record: null };
  const at = view.begins.indexOf(begin);
  return { begin, record: aligned ? (records[at] ?? null) : undefined };
}

function commitsOf(view, fetch) {
  return fetch
    ? view.commits.filter((commit) => commit.fetchSeq === fetch.seq)
    : [];
}

/** Graph content shown although it arrived at or after the window (N1, N29). */
function lateGraphShown(view, fetch, windowMs) {
  const shown = commitsOf(view, fetch).length > 0;
  const result = fetch?.result;
  if (!shown || !result || result.graph === null || result.graph === undefined)
    return false;
  const arrival = graphArrivalOf(view.rowsOf(fetch));
  const rawReady = result.timing?.tRawReadyMs;
  return !(
    finite(arrival) &&
    finite(rawReady) &&
    arrival - rawReady <= windowMs + BOUNDARY_TOLERANCE_MS
  );
}

/** The number of distinct displays one generation published (N1, N32). */
function publishCountOf(view, fetch) {
  return new Set(commitsOf(view, fetch).map((commit) => commit.display)).size;
}

function joinOutcome(result) {
  if (!result) return ["not-returned", null];
  const outcome = result.graphOutcome;
  if (outcome === "graph-ready" || outcome === "graph-late")
    return [outcome, null];
  if (typeof outcome === "string" && outcome.startsWith("graph-unavailable:"))
    return ["graph-unavailable", outcome.slice("graph-unavailable:".length)];
  return ["no-graph-outcome", null];
}

function requalificationOf(result) {
  if (result?.graphOutcome === "graph-ready")
    return Number.isInteger(result.graph?.edgeCount) ? "passed" : null;
  if (result?.graphOutcome === "graph-unavailable:invalidated")
    return "invalidated";
  return null;
}

/**
 * F6 「Graph を持つ」: requalified edges and a contribution from the
 * pre-registered materials (K6/2 step 4; in the steady state, the materials
 * the setup confirmed). The wire carries Scenes, not Revision IDs, so the
 * materials are the expected Graph-only Scene and path-attachment Scenes
 * (runtime ids). Unregistered materials cannot be confirmed (false).
 */
export function expectedContributionOf(graph, expected) {
  if (!graph || !(Number.isInteger(graph.edgeCount) && graph.edgeCount >= 1))
    return false;
  if (!expected) return false;
  const appended = expected.appendedSceneIds ?? [];
  const attached = expected.pathAttachmentSceneIds ?? [];
  return (
    (graph.graphOnlySceneId !== null &&
      appended.includes(graph.graphOnlySceneId)) ||
    (graph.pathAttachmentSceneIds ?? []).some((id) => attached.includes(id))
  );
}

/** F4's observation of what started the child (the harness's view, not the mark). */
function childOriginOf(view) {
  const { parent, child } = view;
  if (child.rawOnly) return "raw-recovery";
  const between = (row) =>
    row.at >= parent.calledAt && row.at <= child.calledAt;
  if (view.notices.some((row) => row.kind === "index-ready" && between(row)))
    return "index-ready";
  if (irRetryTimerOf(parent.result)) return "ir-retry";
  if (view.notices.some((row) => row.kind === "graph-ready" && between(row)))
    return "graph-ready";
  return "unattributed";
}

/** The hook's IR-timeout retry timer runs after a published IR timeout. */
function irRetryTimerOf(result) {
  return (
    result?.resultKind === "raw" &&
    result.irStatus === "unavailable" &&
    result.irReason === "timeout"
  );
}

function ticketOf(record) {
  if (record?.begin !== "pending" || !record.ticket) return null;
  const ticket = record.ticket;
  return {
    settled: ticket.settled === true,
    // An unsettled ticket did not enter the cache when the records were read.
    outcome: ticket.outcome ?? "unsettled",
    reason: ticket.reason ?? null,
    disposition: ticket.disposition ?? null,
    busyCause: ticket.busyCause ?? null,
  };
}

/** Builds the R7 `followUp` record of one steady-state Graph sample. */
export function buildFollowUpRecord({
  observation,
  nativeRecords,
  counters,
  r1,
  r2,
  expectedContribution,
}) {
  const view = viewOf(observation);
  view.expectedContribution = expectedContribution ?? null;
  const { parent, child } = view;
  if (!parent?.result)
    throw new Error(
      "[artifact] the hook consumer recorded no returned parent query in the sample",
    );
  const records = Array.isArray(nativeRecords) ? nativeRecords : [];
  const aligned = records.length === view.begins.length;
  const parentNative = recordOf(view, parent, records, aligned);
  const parentRecord = parentNative.record ?? records[0] ?? null;
  const parentResult = parent.result;
  const tPub = parentResult.timing.tReturnMs;
  const parentRows = view.rowsOf(parent);
  const settle = settleOf(parentRows);
  const parentCommits = commitsOf(view, parent);
  const childCommits = commitsOf(view, child);
  const firstChildCommit = childCommits[0] ?? null;
  const loadingCommit = view.commits.find(
    (commit) =>
      commit.fetchSeq === null &&
      parentCommits.length > 0 &&
      commit.at > parentCommits[0].at &&
      (firstChildCommit === null || commit.at < firstChildCommit.at),
  );
  const diagnosticsBefore = counters?.before ?? {};
  const diagnosticsAfter = counters?.afterRelease ?? counters?.atEnd ?? {};
  const delta = (key) =>
    Number.isInteger(diagnosticsAfter[key]) &&
    Number.isInteger(diagnosticsBefore[key])
      ? diagnosticsAfter[key] - diagnosticsBefore[key]
      : undefined;
  const firstNotice = view.notices.find(
    (row) => row.kind === "graph-ready" && finite(tPub) && row.at > tPub,
  );
  const childBuilt = child
    ? childRecordOf(view, child, records, aligned)
    : null;
  return {
    issuedVia: PRODUCT_HOOK,
    parent: {
      generation: 1,
      queryGeneration: parent.queryGeneration ?? null,
      sceneId: parent.sceneId,
      seed: parent.seed,
      tPub,
      declaration: settle?.settle ?? null,
      declaredAt: settle?.calledAt ?? null,
      graphContinueAnswer: continueAnswerOf(parentRows),
      graphWindowMs: parentResult.timing.graphWindowMs ?? null,
      refreshTrigger: parentResult.timing.refreshTrigger ?? null,
      publishCount: publishCountOf(view, parent),
      lateGraphInDisplay: lateGraphShown(view, parent, GRAPH_EVAL_D_MS),
      rSceneIds: parentResult.rawSceneIds,
      irSceneIds: parentResult.irSceneIds,
      ticket: ticketOf(parentRecord),
      irRetryTimer: irRetryTimerOf(parentResult),
    },
    notices: view.notices.map(({ kind, at }) => ({ kind, at })),
    counters: {
      before: pick(diagnosticsBefore, COUNTER_KEYS),
      after: pick(counters?.atEnd, COUNTER_KEYS),
    },
    countersAfterRelease: pick(counters?.afterRelease, COUNTER_KEYS),
    nativeBegins: records.map((record) => record.begin),
    beginRecordsAligned: aligned,
    r1,
    r2,
    // X2: of TTL, edge epoch and quarantine only the quarantine counter is
    // observable (the owner's counters carry no key; DR-CP4-K64-16 (2)).
    cacheLoss: delta("quarantines") > 0 ? ["quarantine"] : [],
    dPrimeCounters: Object.fromEntries(
      DPRIME_COUNTER_KEYS.map((key) => [key, delta(key)]),
    ),
    loading: loadingCommit
      ? {
          switched: true,
          ms: (firstChildCommit?.at ?? observation.endedAt) - loadingCommit.at,
        }
      : { switched: false, ms: null },
    child: childBuilt?.child ?? null,
    q4: {
      clock: "native-ns, disclosure only (K6/4:133)",
      parent: {
        handOverToSettledMs: nsToMs(
          parentRecord?.tBeginNs,
          parentRecord?.ticket?.tSettledNs,
        ),
        ticketToSettledMs: nsToMs(
          parentRecord?.ticket?.tTicketNs,
          parentRecord?.ticket?.tSettledNs,
        ),
        beginMs: nsToMs(parentRecord?.tBeginNs, parentRecord?.tReturnedNs),
        nativeRawReadyElapsedMs:
          parentResult.timing.native?.rawReadyElapsedMs ?? null,
      },
      // The notice has no Native time; the two clocks are never mixed.
      settledToNoticeMs: null,
      noticeAfterParentPublishMs: firstNotice ? firstNotice.at - tPub : null,
      child: childBuilt?.q4 ?? null,
    },
  };
}

function childRecordOf(view, child, records, aligned) {
  const result = child.result;
  const rows = view.rowsOf(child);
  const native = recordOf(view, child, records, aligned);
  const [outcome, reason] = joinOutcome(result);
  const commits = commitsOf(view, child);
  const firstCommit = commits[0] ?? null;
  const irRow = rows.find((row) => row.cmd === IR_CONTINUE);
  const tRawReady = result?.timing?.tRawReadyMs ?? null;
  return {
    child: {
      origin: childOriginOf(view),
      generation: 2,
      queryGeneration: child.queryGeneration ?? null,
      refreshTrigger:
        result?.timing?.refreshTrigger ?? child.refreshTrigger ?? null,
      graphWindowMs: result?.timing?.graphWindowMs ?? null,
      sceneId: child.sceneId,
      seed: child.seed,
      beginAt: native.begin?.calledAt ?? child.calledAt,
      beginKind:
        native.record === undefined
          ? "unaligned"
          : (native.record?.begin ?? "none"),
      tRawReady,
      tGraph: graphArrivalOf(rows),
      irOutcome: result
        ? (result.completion?.outcome ?? "no-completion")
        : "not-returned",
      irArrivedAt: finite(irRow?.resolvedAt) ? irRow.resolvedAt : null,
      outcome,
      reason,
      edgeCount: Number.isInteger(result?.graph?.edgeCount)
        ? result.graph.edgeCount
        : null,
      expectedContribution: expectedContributionOf(
        result?.graph,
        view.expectedContribution,
      ),
      requalification: requalificationOf(result),
      completion: result?.status ?? "not-returned",
      publishCount: publishCountOf(view, child),
      currentAtDisplay:
        firstCommit !== null &&
        !view.fetches.some(
          (fetch) => fetch.seq > child.seq && fetch.calledAt <= firstCommit.at,
        ),
      tFollow: result?.timing?.tReturnMs ?? null,
      reactCommitAt: firstCommit?.at ?? null,
      lateGraphInDisplay: lateGraphShown(view, child, K64_W_F_MS),
      chronicleIndexUsable: result?.initialSnapshot?.indexUsable,
      rSceneIds: result?.rawSceneIds ?? [],
      irSceneIds: result?.irSceneIds ?? [],
      finalSceneIds: result?.finalSceneIds ?? [],
    },
    q4: {
      beginMs: nsToMs(native.record?.tBeginNs, native.record?.tReturnedNs),
      nativeRawReadyElapsedMs:
        result?.timing?.native?.rawReadyElapsedMs ?? null,
      firstSnapshotElapsedMs:
        result?.timing?.native?.firstSnapshotElapsedMs ?? null,
    },
  };
}

/**
 * The `measure` summary of the parent query (run-sample.mjs `sampleRow`
 * reads it): the parent's result and the API rows it issued.
 */
function parentMeasure(view) {
  const result = view.parent.result;
  return {
    status: result.status,
    rawStatus: result.rawStatus,
    timing: {
      tFetchMs: result.timing.tFetchMs,
      tRawReadyMs: result.timing.tRawReadyMs,
      tReturnMs: result.timing.tReturnMs,
      native: result.timing.native ?? null,
    },
    initialSnapshot: result.initialSnapshot,
    completion: result.completion,
    resultKind: result.resultKind,
    graphOutcome: result.graphOutcome ?? null,
    graph: result.graph ?? null,
    rawSceneIds: result.rawSceneIds,
    finalSceneIds: result.finalSceneIds,
    ipc: view.rowsOf(view.parent),
  };
}

/**
 * One measured (or warm-up) R+IR+Graph sample of the steady state from the
 * hook consumer: the parent's S1b fields (`sampleRow`) and the R7 record.
 * The Graph arm's seed is the one the hook read from the pin (R5); a sample
 * whose parent carried no seed stops the run with `[precheck]`.
 */
export function k64GraphSampleRow(input) {
  const {
    variantKey,
    phase,
    repeat,
    d2aMode,
    observation,
    nativeRecords,
    a3 = null,
    r1,
  } = input;
  const view = viewOf(observation);
  if (!view.parent?.result)
    throw new Error(
      "[artifact] the hook consumer recorded no returned parent query in the sample",
    );
  if (typeof view.parent.seed !== "string")
    throw new Error(
      "[precheck] R5: the product hook sent no seed for a Graph-arm sample (the query Scene's first pin)",
    );
  const records = Array.isArray(nativeRecords) ? nativeRecords : [];
  const row = sampleRow({
    variantKey,
    arm: "graph",
    phase,
    repeat,
    d2aMode,
    measure: parentMeasure(view),
    nativeRecord: records[0] ?? null,
    a3,
    readyWait: r1,
  });
  return {
    ...row,
    runnerKind: K64_RUNNER_KIND,
    sampleEnd: {
      reason: observation.endReason ?? null,
      fetches: view.fetches.length,
    },
    followUp: buildFollowUpRecord(input),
  };
}

/** q4 distributions of a set of samples (K6/4-P3; disclosure only). */
export function summarizeQ4(samples) {
  const records = samples
    .map((row) => row.followUp?.q4)
    .filter((value) => value && typeof value === "object");
  const values = (pick) => records.map(pick).filter(finite);
  return {
    clock: "native-ns, disclosure only (K6/4:133)",
    parentHandOverToSettledMs: distribution(
      values((row) => row.parent?.handOverToSettledMs),
    ),
    parentTicketToSettledMs: distribution(
      values((row) => row.parent?.ticketToSettledMs),
    ),
    noticeAfterParentPublishMs: distribution(
      values((row) => row.noticeAfterParentPublishMs),
    ),
    childBeginMs: distribution(values((row) => row.child?.beginMs)),
    childNativeRawReadyElapsedMs: distribution(
      values((row) => row.child?.nativeRawReadyElapsedMs),
    ),
    settledToNotice: "not-measured:no-native-notice-time",
  };
}
