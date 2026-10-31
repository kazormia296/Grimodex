// DR-CP4-TR-1〜3: (b) の trace の記録（純粋な部分）。合成の trace（編集中と閲覧中）、
// 合成の Native の記録と Main の poller の読取で、query ごとの行が分類器
// （followup.mjs の trace の文脈、availability.mjs の summarizeTrace と
// validateTraceEvents）の求める欄を満たし、境の counter と begin の記録の並びが
// F2 の規則どおりに効くことを確かめる。分類器そのものは変えない。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setTimeout } from "node:timers";
import { classifyFollowUp } from "./followup.mjs";
import { lapseKind } from "./join.mjs";
import {
  K64_CHILD_RESULT,
  k64Api,
  k64FetchResult,
  k64NativeRecord,
  ratification5,
} from "./test-support.mjs";
import {
  COUNTER_POLL_SOURCE,
  COUNTER_POLL_DRAIN_SOURCE,
  COUNTER_POLL_STOP_SOURCE,
  TRACE_COUNTER_KEYS,
  alignSeededBegins,
  alignmentDisclosure,
  appendCounterRun,
  assertTraceMaterialsMatch,
  boundaryCounters,
  cancelledParentSeqsOf,
  cancelledParentsDisclosure,
  devTracePlan,
  lapseIBreakdown,
  mergeNativeRecords,
  mixWindowAfter,
  nativeReadClockRange,
  requeryAfterCycleEndDisclosure,
  requeryAfterCycleEndViolations,
  startSealCounts,
  startSealOf,
  summarizeTraceRun,
  traceAlignment,
  traceEvents,
  traceQueryRow,
  traceRequeries,
  traceRows,
  validateTracePlan,
} from "./trace-record.mjs";

const SCENE = "scene-q";
const OTHER = "scene-o";
const SEED = "entity-seed";
const MS = 1e6;
const ns = (ms) => Math.round(ms * MS);

function plan(kind, cycles = 2) {
  return devTracePlan({
    kind,
    cycles,
    querySceneId: SCENE,
    otherSceneId: OTHER,
    seedEntityId: SEED,
    materials: ["rev-1"],
  });
}

/**
 * Polls every `stepMs` (read 0.01 ms after the clock, clock again 0.01 ms
 * after) of the counter state the synthetic begin and store events make.
 */
function pollRuns(events, fromMs, toMs, stepMs = 1, skip = () => false) {
  const sorted = [...events].sort((left, right) => left.at - right.at);
  const counters = Object.fromEntries(TRACE_COUNTER_KEYS.map((k) => [k, 0]));
  let next = 0;
  const runs = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const readAt = Math.round((t + 0.01) * MS);
    while (next < sorted.length && sorted[next].at <= readAt) {
      for (const [key, value] of Object.entries(sorted[next].add))
        counters[key] += value;
      next += 1;
    }
    if (skip(t)) continue;
    appendCounterRun(runs, {
      beforeNs: Math.round(t * MS),
      counters: { ...counters },
      afterNs: Math.round((t + 0.02) * MS),
    });
  }
  return runs;
}

/**
 * One counted query at base time `B` (renderer ms; the Native ns are B·1e6 on
 * the same numbers, which the code never mixes): a graph-late parent, one
 * notice, a Cached child that joins its Graph within W_f and publishes.
 */
function queryParts(index, { child = true, extraBegin = false } = {}) {
  const B = 10_000 + index * 3_000;
  const p = 2 * index + 1;
  const c = 2 * index + 2;
  const parent = {
    seq: p,
    sceneId: SCENE,
    queryGeneration: 100 + 2 * index,
    refreshTrigger: null,
    seed: SEED,
    rawOnly: false,
    calledAt: B,
    resolvedAt: B + 61,
    failed: false,
    result: k64FetchResult({
      timing: { tFetchMs: B, tRawReadyMs: B + 50, tReturnMs: B + 60.9 },
    }),
  };
  const fetches = [parent];
  const api = [
    k64Api("related_scenes_begin", B + 10, B + 30),
    k64Api("related_scenes_continue", B + 50.5, B + 53),
    k64Api("related_scenes_graph_continue", B + 50.5, B + 80, {
      status: "unavailable",
      reason: "cancelled",
    }),
    k64Api("related_scenes_graph_continue", B + 60.85, B + 62, {
      settle: "unused",
    }),
  ];
  const commits = [
    { at: B + 61.5, fetchSeq: p, loading: false, display: `parent-${index}` },
  ];
  const notices = [];
  const records = [
    k64NativeRecord({
      seq: 10 * index + 1,
      tBeginNs: ns(B + 15),
      tReturnedNs: ns(B + 16),
      ticket: {
        ...k64NativeRecord().ticket,
        tTicketNs: ns(B + 15.5),
        tSettledNs: ns(B + 64),
        freshnessStamp: {
          attemptedAtNs: ns(B + 15.2),
          result: "fresh",
          matched: true,
        },
      },
    }),
  ];
  const events = [
    { at: ns(B + 15), add: { begins: 1 } },
    // The parent ticket's late result fills the cache after the publish.
    { at: ns(B + 64), add: { lateCached: 1 } },
  ];
  if (child) {
    notices.push({ kind: "graph-ready", at: B + 67 });
    commits.push({
      at: B + 67.5,
      fetchSeq: p,
      loading: true,
      display: `parent-${index}`,
    });
    fetches.push({
      seq: c,
      sceneId: SCENE,
      queryGeneration: 101 + 2 * index,
      refreshTrigger: "graph-ready",
      seed: SEED,
      rawOnly: false,
      calledAt: B + 68,
      resolvedAt: B + 96,
      failed: false,
      result: k64FetchResult({
        ...K64_CHILD_RESULT,
        timing: {
          ...K64_CHILD_RESULT.timing,
          tFetchMs: B + 68,
          tRawReadyMs: B + 75,
          tReturnMs: B + 95,
        },
      }),
    });
    api.push(
      k64Api("related_scenes_begin", B + 68.5, B + 70),
      k64Api("related_scenes_continue", B + 75.2, B + 81),
      k64Api("related_scenes_graph_continue", B + 75.2, B + 89, {
        status: "available",
      }),
      k64Api("related_scenes_graph_continue", B + 95, B + 96, {
        settle: "used",
      }),
    );
    commits.push({
      at: B + 96,
      fetchSeq: c,
      loading: false,
      display: `child-${index}`,
    });
    if (extraBegin) {
      // Another seeded begin between the parent's and the child's begin.
      records.push(
        k64NativeRecord({
          seq: 10 * index + 2,
          tBeginNs: ns(B + 66),
          tReturnedNs: ns(B + 66.5),
          begin: "unavailable",
          reason: "busy",
          busyCause: "in-use",
          ticket: null,
        }),
      );
      events.push({ at: ns(B + 66), add: { begins: 1 } });
    }
    records.push(
      k64NativeRecord({
        seq: 10 * index + 3,
        tBeginNs: ns(B + 69),
        tReturnedNs: ns(B + 69.5),
        startSlot: {
          kind: "empty",
          readyFresh: false,
          preparesReady: 3,
          readyGeneration: 3,
        },
        begin: "cached",
        ticket: null,
      }),
    );
    events.push({ at: ns(B + 69), add: { begins: 1, cacheHits: 1 } });
  }
  return { B, parent, fetches, api, commits, notices, records, events };
}

function a3(index) {
  const B = 10_000 + index * 3_000;
  return {
    schema: "nir1-graph-eval-a3/1",
    connection: "read-only-own",
    readOnly: true,
    queryOnly: true,
    tOpenStartedNs: ns(B + 3),
    tSnapshotNs: ns(B + 3.5),
    tFinishedNs: ns(B + 4),
    revisions: [{ revisionId: "rev-1", a3: "eligible", reason: null }],
  };
}

/**
 * A synthetic editing trace of `n` counted queries: the edit, the autosave
 * commit 400 ms before each query after the first, the parts above, and the
 * runner's operation log.
 */
function editingTrace(n, options = {}) {
  const observation = {
    fetches: [],
    api: [],
    commits: [],
    notices: [],
    bodyCommits: [],
    initialVersion: 7,
    observedUntil: 10_000 + n * 3_000,
  };
  const records = [];
  const events = [];
  const log = [];
  const a3Reads = {};
  for (let index = 0; index < n; index++) {
    const parts = queryParts(index, options[index] ?? {});
    observation.fetches.push(...parts.fetches);
    observation.api.push(...parts.api);
    observation.commits.push(...parts.commits);
    observation.notices.push(...parts.notices);
    records.push(...parts.records);
    events.push(...parts.events);
    a3Reads[parts.parent.seq] = a3(index);
    if (index > 0) {
      log.push(
        {
          op: "edit",
          caretAt: parts.B - 2_700,
          startedAt: parts.B - 2_690,
          endedAt: parts.B - 2_600,
        },
        { op: "confirm-autosave-commit", at: parts.B - 400 },
      );
      observation.bodyCommits.push({
        at: parts.B - 400,
        sceneId: SCENE,
        contentVersion: 7 + index,
      });
    }
    log.push({
      op: index === 0 ? "open-scene" : "product-query",
      index,
      parentSeq: parts.parent.seq,
      calledAt: parts.B,
      cycleEnd: {
        reason:
          options[index]?.child === false
            ? "t-show-elapsed"
            : "child-published",
        at: options[index]?.child === false ? parts.B + 2_050 : parts.B + 96.5,
      },
    });
  }
  observation.api.forEach((row, at) => {
    row.id = at;
  });
  // The Native's per-begin seq is consecutive (レビュー P2-4).
  records.forEach((record, at) => {
    record.seq = at + 1;
  });
  return { observation, records, events, log, a3Reads };
}

function rowsOf(trace, n, runs, overrides = {}) {
  const merged = mergeNativeRecords([{ dropped: 0, records: trace.records }]);
  return traceRows({
    plan: plan("editing", n - 1),
    observation: trace.observation,
    log: trace.log,
    native: merged,
    runs,
    a3Reads: trace.a3Reads,
    d2aMode: "restricted",
    ids: { revisions: { "rev-1": "rev-1" } },
    expectedContribution: {
      appendedSceneIds: ["dev-added"],
      pathAttachmentSceneIds: ["dev-b"],
    },
    ...overrides,
  });
}

test("TR-1: dev の trace の plan は S2 の file と同じ形で、検査を通る。承認、別の seed、editor でない編集、番号の欠け、Q の不一致は拒む", () => {
  for (const kind of ["editing", "browsing"]) {
    const value = plan(kind, 3);
    assert.deepEqual(validateTracePlan(value, { preview: true }), []);
    assert.equal(value.plannedQ, 4);
    assert.equal(
      value.operations.filter((row) => row.query?.counted).length,
      4,
    );
  }
  // 正式の trace は Q≥200 を求める（dev の予告だけ短くてよい）。
  assert.match(
    validateTracePlan(plan("editing", 3)).join("\n"),
    /fewer than 200/u,
  );
  const broken = (mutate) => {
    const value = JSON.parse(JSON.stringify(plan("editing", 2)));
    mutate(value);
    return validateTracePlan(value, { preview: true }).join("\n");
  };
  assert.match(
    broken((v) => v.operations.splice(2, 0, { seq: 99, op: "approval" })),
    /approval|unknown op/u,
  );
  assert.match(
    broken((v) => {
      v.operations[3].query.seed = "other";
    }),
    /seed/u,
  );
  assert.match(
    broken((v) => {
      v.operations[1].via = "direct-write";
    }),
    /product-editor/u,
  );
  assert.match(
    broken((v) => {
      v.operations[3].query.index = 5;
    }),
    /index/u,
  );
  assert.match(
    broken((v) => {
      v.plannedQ = 9;
    }),
    /plannedQ/u,
  );
  assert.match(
    broken((v) => {
      v.operations.splice(2, 1);
    }),
    /cycle|pattern|seq/u,
  );
  assert.match(
    broken((v) => {
      v.kind = "replay";
    }),
    /kind/u,
  );
});

test("TR-2: 境の counter は区間の端の読取で、同じ run を跨げば exact、跨がなければ bracketed、読取が無ければ null", () => {
  const events = [
    { at: 10 * MS, add: { begins: 1 } },
    { at: 30 * MS, add: { lateCached: 1 } },
    { at: 50 * MS, add: { begins: 1, cacheHits: 1 } },
  ];
  const runs = pollRuns(events, 0, 100, 1);
  const exact = boundaryCounters(runs, {
    beginNs: 10.5 * MS,
    endNs: 50.5 * MS,
  });
  assert.equal(exact.read, "exact");
  assert.equal(exact.after.lateCached - exact.before.lateCached, 1);
  // 端の近くに読取が無い（poller の間隔より短い間に入った store）は bracketed。
  const sparse = pollRuns(events, 0, 100, 1, (t) => t > 25 && t < 35);
  const bracketed = boundaryCounters(sparse, {
    beginNs: 30.005 * MS,
    endNs: 50.5 * MS,
  });
  assert.equal(bracketed.read, "bracketed");
  assert.ok(bracketed.beforeGapNs > 0);
  // 区間は真の区間を含む（厳しい側）: 端の前の store も差分に入る。
  assert.equal(bracketed.after.lateCached - bracketed.before.lateCached, 1);
  assert.equal(boundaryCounters([], { beginNs: 1, endNs: 2 }), null);
  assert.equal(
    boundaryCounters(runs, { beginNs: 10.5 * MS, endNs: 500 * MS }),
    null,
  );
});

test("TR-2: Main の poller の source は同じ tick で clock と diagnostics を読み、同じ値を 1 つの run にまとめ、drain と stop で取り出して止める", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-tr-poll-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-native.cjs");
  writeFileSync(
    file,
    `let t = 1000; let late = 0; let calls = 0;
module.exports = {
  nir1GraphEvalClockNs() { t += 10; return String(t); },
  nir1GraphEvalDiagnostics() {
    calls += 1; if (calls === 3) late += 1; t += 5;
    return JSON.stringify({ begins: 2, cacheHits: 0, lateCached: late, quarantines: 0, deferredReleased: 0, deferredExpired: 0, deferredDropped: 0, staleReadyRetired: 0, prepareFailures: 0, driftAtQuery: 0, stamp0Missing: 0, clockNs: t });
  },
};`,
  );
  delete globalThis.__cp4TraceCounterPoll;
  const installed = JSON.parse(
    await COUNTER_POLL_SOURCE(null, [file, 1, TRACE_COUNTER_KEYS]),
  );
  assert.equal(installed.installed, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stopped = JSON.parse(await COUNTER_POLL_STOP_SOURCE());
  assert.equal(stopped.stopped, true);
  const drained = JSON.parse(await COUNTER_POLL_DRAIN_SOURCE());
  assert.ok(drained.polls >= 3);
  assert.equal(drained.errors, 0);
  assert.equal(drained.runs[0].counters.lateCached, 0);
  assert.equal(drained.runs[1].counters.lateCached, 1);
  assert.ok(drained.runs[0].firstBeforeNs < drained.runs[0].firstAfterNs);
  assert.equal(drained.runs.length, 2);
  // The inlined logic keeps the same run shape as appendCounterRun.
  const reference = appendCounterRun([], {
    beforeNs: 1,
    counters: drained.runs[0].counters,
    afterNs: 2,
  });
  assert.deepEqual(
    Object.keys(drained.runs[0]).sort(),
    Object.keys(reference[0]).sort(),
  );
  assert.equal(drained.runs[0].key, reference[0].key);
  // 止めた後は読まない。
  const polls = drained.polls;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(JSON.parse(await COUNTER_POLL_DRAIN_SOURCE()).polls, polls);
  delete globalThis.__cp4TraceCounterPoll;
});

test("TR-3: Native の記録は seq で併合し（後の読取の ticket の状態を採る）、累積の dropped だけでは失わず、seq の欠けか最初の読取の dropped で失ったとする（レビュー P2-4）", () => {
  const first = k64NativeRecord({
    seq: 1,
    ticket: { ...k64NativeRecord().ticket, settled: false, outcome: null },
  });
  const later = k64NativeRecord({ seq: 1 });
  // The log pushed out seq 1 and 2 after they were read: no loss.
  const merged = mergeNativeRecords([
    { dropped: 0, records: [first, k64NativeRecord({ seq: 2 })] },
    {
      dropped: 0,
      records: [
        later,
        k64NativeRecord({ seq: 2 }),
        k64NativeRecord({ seq: 3 }),
      ],
    },
    { dropped: 2, records: [k64NativeRecord({ seq: 3 })] },
  ]);
  assert.deepEqual(
    merged.records.map((row) => row.seq),
    [1, 2, 3],
  );
  assert.equal(merged.records[0].ticket.settled, true);
  assert.equal(merged.dropped, 2);
  assert.equal(merged.lost, false);
  // seq 2 was pushed out before any read captured it.
  const gap = mergeNativeRecords([
    { dropped: 0, records: [k64NativeRecord({ seq: 1 })] },
    { dropped: 2, records: [k64NativeRecord({ seq: 3 })] },
  ]);
  assert.equal(gap.lost, true);
  assert.deepEqual(gap.gaps, [[1, 3]]);
  // The first read already counts dropped records.
  const front = mergeNativeRecords([
    { dropped: 1, records: [k64NativeRecord({ seq: 2 })] },
  ]);
  assert.equal(front.lost, true);
  assert.equal(front.frontLoss, true);
  const aligned = alignSeededBegins({
    observation: { fetches: [], api: [] },
    native: gap,
  });
  assert.equal(aligned.aligned, false);
  assert.match(aligned.reason, /lost records/u);
});

test("TR-3: seed つきの fetch の begin の呼出しと Native の記録を順に対応させ、seed の無い begin は除き、数が違えば整列の失敗にする", () => {
  const trace = editingTrace(2);
  const unseeded = {
    seq: 50,
    sceneId: OTHER,
    queryGeneration: 9,
    refreshTrigger: null,
    seed: null,
    rawOnly: false,
    calledAt: 12_500,
    resolvedAt: 12_560,
    failed: false,
    result: k64FetchResult(),
  };
  const observation = {
    ...trace.observation,
    fetches: [...trace.observation.fetches, unseeded],
    api: [
      ...trace.observation.api,
      { ...k64Api("related_scenes_begin", 12_501, 12_510), id: 999 },
    ],
  };
  const merged = mergeNativeRecords([{ dropped: 0, records: trace.records }]);
  const aligned = alignSeededBegins({ observation, native: merged });
  assert.equal(aligned.aligned, true);
  assert.equal(aligned.seededBegins, 4);
  assert.equal(aligned.recordOf.get(999), undefined);
  const short = alignSeededBegins({
    observation,
    native: { ...merged, records: merged.records.slice(1) },
  });
  assert.equal(short.aligned, false);
  assert.match(short.reason, /4 seeded begins, 3 records/u);
  // A cumulative dropped count without a gap aligns.
  const dropped = alignSeededBegins({
    observation,
    native: { ...merged, dropped: 1 },
  });
  assert.equal(dropped.aligned, true);
});

test("TR-3: counted query の行は分類器の trace の文脈で follow-up の成功になり、R7 の欄を欠かない", () => {
  const trace = editingTrace(3);
  const runs = pollRuns(trace.events, 9_000, 18_000, 1);
  const rows = rowsOf(trace, 3, runs);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.trigger, "user-operation");
    assert.deepEqual(row.expectedMaterials, ["rev-1"]);
    assert.equal(row.followUp.boundary.read, "exact");
    assert.deepEqual(row.followUp.nativeBegins, ["pending", "cached"]);
    assert.equal(row.followUp.r1, undefined);
    assert.equal(row.followUp.countersAfterRelease, undefined);
    const result = classifyFollowUp(row, { context: "trace" });
    assert.deepEqual(result.stages, []);
    assert.equal(result.followUp, true, JSON.stringify(result.stages));
  }
  assert.equal(rows[1].queryId, `${plan("editing", 2).traceId}#1`);
});

test("TR-2/3: 境の差分が 2（区間の端に別の store）は X4、counter の読取が無ければ X10、renderer の呼出しの無い begin が混ざれば整列の失敗（行は R7 を欠く）", () => {
  const trace = editingTrace(2);
  // 親の begin の直前（poller の間隔より短い）に前の query の store が入った。
  const events = [
    ...trace.events,
    { at: 13_014.995 * MS, add: { lateCached: 1 } },
  ];
  const runs = pollRuns(
    events,
    9_000,
    18_000,
    1,
    (t) => t > 13_010 && t < 13_016,
  );
  const [, second] = rowsOf(trace, 2, runs);
  assert.equal(second.followUp.boundary.read, "bracketed");
  const result = classifyFollowUp(second, { context: "trace" });
  assert.equal(result.followUp, false);
  assert.match(result.x.X4, /late-cached:2/u);

  const missing = rowsOf(trace, 2, []);
  const x10 = classifyFollowUp(missing[0], { context: "trace" });
  assert.match(x10.x.X10, /missing:.*counters/u);

  const extra = editingTrace(2, { 1: { extraBegin: true } });
  const extraRuns = pollRuns(extra.events, 9_000, 18_000, 1);
  // 間の begin は renderer の呼出しを持たない（例: D-final）ので、整列は崩れる。
  const extraRows = rowsOf(extra, 2, extraRuns);
  assert.equal(extraRows[1].followUp, null);
  assert.match(extraRows[1].rowError, /seeded begins/u);
});

test("TR-3: 混入の観測の窓は子の continue がすべて返り t_raw_ready_c + W_f と余裕が観測の内なら settled、外なら harness-limit（X10）", () => {
  const { fetches, api } = queryParts(0);
  const observation = { fetches, api: api.map((row, id) => ({ ...row, id })) };
  const settled = mixWindowAfter({
    observation,
    parent: fetches[0],
    child: fetches[1],
    observedUntil: 11_000,
  });
  assert.equal(settled.reason, "settled");
  assert.equal(settled.until, 10_000 + 75 + 100 + 16);
  const cut = mixWindowAfter({
    observation,
    parent: fetches[0],
    child: fetches[1],
    observedUntil: 10_150,
  });
  assert.equal(cut.reason, "harness-limit");
  const open = mixWindowAfter({
    observation: {
      ...observation,
      api: observation.api.map((row) =>
        row.cmd === "related_scenes_graph_continue" && row.calledAt > 10_070
          ? { ...row, resolvedAt: null }
          : row,
      ),
    },
    parent: fetches[0],
    child: fetches[1],
    observedUntil: 11_000,
  });
  assert.equal(open.reason, "harness-limit");
  assert.equal(
    mixWindowAfter({ observation, parent: fetches[0], child: null }).reason,
    "not-applied",
  );
});

test("TR-3: 子が無い query は X6（no-child）、取り直しは行にせず契機ごとに数え、seed の無い query は Q の外に数える", () => {
  const trace = editingTrace(2, { 1: { child: false } });
  const runs = pollRuns(trace.events, 9_000, 18_000, 1);
  const rows = rowsOf(trace, 2, runs);
  const result = classifyFollowUp(rows[1], { context: "trace" });
  assert.equal(result.x.X6, "no-child");
  const requeries = traceRequeries({
    observation: {
      ...trace.observation,
      fetches: [
        ...trace.observation.fetches,
        {
          seq: 70,
          sceneId: OTHER,
          seed: null,
          refreshTrigger: null,
          calledAt: 15_000,
          result: null,
        },
        {
          seq: 71,
          sceneId: SCENE,
          seed: SEED,
          refreshTrigger: null,
          calledAt: 15_100,
          result: null,
        },
      ],
      notices: [
        ...trace.observation.notices,
        { kind: "index-ready", at: 15_050 },
      ],
    },
    parentSeqs: [1, 3],
  });
  assert.deepEqual(requeries.counts, {
    "graph-ready": 1,
    "index-ready": 1,
    "ir-retry": 0,
    unattributed: 0,
    "outside-q": 1,
  });
});

test("TR-1/3: events は validateTraceEvents の密度の規則を満たし、commit の後の harness の操作と editor でない編集を拒む", () => {
  const trace = editingTrace(3);
  const events = traceEvents({
    plan: plan("editing", 2),
    observation: trace.observation,
    log: trace.log,
    parentSeqs: [1, 3, 5],
  });
  const runs = pollRuns(trace.events, 9_000, 20_000, 1);
  const rows = rowsOf(trace, 3, runs);
  const ok = summarizeTraceRun({
    plan: plan("editing", 2),
    rows,
    events,
    fixedGraphMode: "restricted",
  });
  assert.deepEqual(ok.events.errors, []);
  assert.equal(ok.events.queries, 3);
  assert.deepEqual(ok.defects, []);
  const late = traceEvents({
    plan: plan("editing", 2),
    observation: trace.observation,
    log: [
      ...trace.log,
      // A harness operation between the second commit and its query.
      { op: "harness-wait", at: 12_800 },
    ],
    parentSeqs: [1, 3, 5],
  });
  const bad = summarizeTraceRun({
    plan: plan("editing", 2),
    rows,
    events: late,
    fixedGraphMode: "restricted",
  });
  assert.match(bad.events.errors.join("\n"), /harness wait or operation/u);
  assert.ok(bad.defects.length > 0);
  // A plan with more counted queries than the trace observed is a defect.
  const short = summarizeTraceRun({
    plan: plan("editing", 3),
    rows,
    events,
    fixedGraphMode: "restricted",
  });
  assert.match(short.defects.join("\n"), /the plan has 4/u);
});

test("TR-3: 閲覧中の trace は seed の無い場面の query を Q の外にし、編集と保存を含まない", () => {
  const trace = editingTrace(2);
  const browsing = plan("browsing", 1);
  const observation = {
    ...trace.observation,
    bodyCommits: [],
    fetches: [
      ...trace.observation.fetches,
      {
        seq: 60,
        sceneId: OTHER,
        seed: null,
        refreshTrigger: null,
        calledAt: 11_500,
        result: null,
      },
    ],
  };
  const log = [
    trace.log[0],
    { op: "navigate", sceneId: OTHER, at: 11_000 },
    { op: "navigate", sceneId: SCENE, at: 12_000 },
    trace.log.at(-1),
  ];
  const events = traceEvents({
    plan: browsing,
    observation,
    log,
    parentSeqs: [1, 3],
  });
  const runs = pollRuns(trace.events, 9_000, 18_000, 1);
  const rows = rowsOf(trace, 2, runs, { plan: browsing });
  const run = summarizeTraceRun({
    plan: browsing,
    rows,
    events,
    fixedGraphMode: "restricted",
  });
  assert.deepEqual(run.events.errors, []);
  assert.equal(run.events.queries, 2);
  assert.ok(events.some((row) => row.trigger === "outside-q"));
});

test("TR-3: Q=200 の合成の編集中の trace は K6/2 の読みで valid に集計され、K6/4 の読みは F6 の preview の単位で invalid（DR-CP4-F-6）", () => {
  const n = 200;
  const trace = editingTrace(n);
  const runs = pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  const longPlan = plan("editing", n - 1);
  const rows = rowsOf(trace, n, runs, { plan: longPlan });
  const events = traceEvents({
    plan: longPlan,
    observation: trace.observation,
    log: trace.log,
    parentSeqs: rows.map((_, at) => 2 * at + 1),
  });
  const k62 = summarizeTraceRun({
    plan: longPlan,
    rows,
    events,
    fixedGraphMode: "restricted",
  });
  assert.deepEqual(k62.defects, []);
  assert.equal(k62.summary.status, "valid");
  assert.equal(k62.summary.Q, 200);
  const k64 = summarizeTraceRun({
    plan: longPlan,
    rows,
    events,
    fixedGraphMode: "restricted",
    candidate: ratification5(),
    candidateHead: "e".repeat(40),
  });
  assert.equal(k64.summary.status, "invalid");
  assert.match(k64.summary.invalid.join("\n"), /DR-CP4-F-6/u);
});

test("TR-3: traceQueryRow は親の seed が無ければ [precheck]（R5）で止まる", () => {
  const trace = editingTrace(1);
  trace.observation.fetches[0].seed = null;
  const merged = mergeNativeRecords([{ dropped: 0, records: trace.records }]);
  assert.throws(
    () =>
      traceQueryRow({
        plan: plan("editing", 0),
        index: 0,
        logEntry: trace.log[0],
        nextParentSeq: null,
        observation: trace.observation,
        alignment: alignSeededBegins({
          observation: trace.observation,
          native: merged,
        }),
        native: merged,
        runs: [],
        a3: a3(0),
        d2aMode: "restricted",
        materials: ["rev-1"],
        expectedContribution: null,
      }),
    /\[precheck\] R5/u,
  );
});

const sealRead = (index, b, extra = {}) => ({
  read: "ok",
  b,
  chronicle: { generation: 1, dirty: false },
  startedAt: 10_000 + index * 3_000 - 300,
  finishedAt: 10_000 + index * 3_000 - 299,
  durationMs: 0.5,
  ...extra,
});
const sealAfter = (index, b, extra = {}) =>
  sealRead(index, b, {
    startedAt: 10_000 + index * 3_000 + 5,
    finishedAt: 10_000 + index * 3_000 + 6,
    ...extra,
  });
const CURRENT = { generation: 4, dirty: false };
const pair = (index, before, after = before, extra = {}) => ({
  before: sealRead(index, before, extra.before),
  after: sealAfter(index, after, extra.after),
});

test("TR-9: 開始時の封印の規則（先に固定）: 2 回とも current で generation が同じときだけ current。dirty／missing は前の読取、読めない・遅い・食い違い・読んでいないは unknown（レビュー P2-1）", () => {
  const state = (value) => startSealOf(value, 10_000);
  assert.equal(state(pair(0, CURRENT)).state, "current");
  assert.equal(state(pair(0, CURRENT)).generation, 4);
  assert.equal(state(pair(0, { generation: 4, dirty: true })).state, "dirty");
  assert.equal(state(pair(0, null)).state, "missing");
  assert.equal(
    state(
      pair(0, CURRENT, CURRENT, { before: { read: "failed", error: "busy" } }),
    ).reason,
    "read-failed:busy",
  );
  assert.deepEqual(
    Object.values(
      state(pair(0, CURRENT, CURRENT, { before: { finishedAt: 10_000 } })),
    ).slice(0, 2),
    ["unknown", "read-not-before-query"],
  );
  assert.equal(
    state(pair(0, CURRENT, { generation: 5, dirty: false })).reason,
    "changed-around-start",
  );
  assert.equal(
    state(pair(0, CURRENT, { generation: 4, dirty: true })).reason,
    "changed-around-start",
  );
  assert.equal(state(pair(0, CURRENT, null)).reason, "changed-around-start");
  assert.equal(
    state(pair(0, CURRENT, CURRENT, { after: { read: "failed", error: "x" } }))
      .state,
    "unknown",
  );
  assert.equal(
    state(pair(0, CURRENT, CURRENT, { after: { startedAt: 9_999 } })).reason,
    "read-after-start-not-after-query",
  );
  assert.equal(
    state({ before: sealRead(0, CURRENT) }).reason,
    "not-read-after-start",
  );
  assert.equal(state(undefined).reason, "not-read");
});

test("TR-9: 行の snapshot は開始時の封印で決め（current のときだけ U）、Native の begin からの snapshot は開示に残す。unknown は U に入れず別に数える", () => {
  const trace = editingTrace(4);
  const runs = pollRuns(trace.events, 9_000, 23_000, 1);
  const seals = {
    0: pair(0, CURRENT),
    1: pair(1, { generation: 4, dirty: true }),
    2: pair(2, CURRENT, CURRENT, { before: { read: "failed", error: "busy" } }),
    // 3: not read
  };
  const rows = rowsOf(trace, 4, runs, {
    plan: plan("editing", 3),
    startSeals: seals,
  });
  assert.deepEqual(
    rows.map((row) => [row.startSeal.state, row.snapshot.usable]),
    [
      ["current", true],
      ["dirty", false],
      ["unknown", false],
      ["unknown", false],
    ],
  );
  assert.equal(rows[1].snapshot.reason, "start-seal:dirty");
  assert.equal(rows[1].snapshotNative.usable, true);
  assert.deepEqual(startSealCounts(rows), {
    current: 1,
    dirty: 1,
    missing: 0,
    unknown: 2,
  });
  // The classifier (unchanged) keeps them out of U: K6/2 rule 3 (i).
  assert.deepEqual(
    rows.map((row) => lapseKind(row, false)),
    [null, "i-b-seal", "i-b-seal", "i-b-seal"],
  );
});

test("レビュー P1-1: 閲覧中、子の無い親の窓に seed の無い場面の fetch と commit が入っても子にせず（X6 のまま、X10 にしない）、窓は次の移動で終わる", () => {
  for (const withOutside of [false, true]) {
    const trace = editingTrace(2, { 0: { child: false } });
    if (withOutside) {
      trace.observation.fetches.push({
        seq: 60,
        sceneId: OTHER,
        seed: null,
        refreshTrigger: null,
        rawOnly: false,
        queryGeneration: 9,
        calledAt: 12_500,
        resolvedAt: 12_560,
        failed: false,
        result: k64FetchResult({
          timing: { tFetchMs: 12_500, tRawReadyMs: 12_540, tReturnMs: 12_559 },
        }),
      });
      trace.observation.api.push({
        ...k64Api("related_scenes_begin", 12_501, 12_510),
        id: 900,
      });
      trace.observation.commits.push(
        // The other Scene's loading state and its result.
        { at: 12_502, fetchSeq: null, loading: true, display: null },
        { at: 12_561, fetchSeq: 60, loading: false, display: "harbor" },
      );
      // A notice during the stay on the other Scene (after the move).
      trace.observation.notices.push({ kind: "graph-ready", at: 12_700 });
    }
    // The moves of the browsing trace after query 0's cycle end.
    const log = [
      trace.log[0],
      { op: "navigate", sceneId: OTHER, at: 12_400 },
      { op: "navigate", sceneId: SCENE, at: 12_900 },
      trace.log.at(-1),
    ];
    const runs = pollRuns(trace.events, 9_000, 18_000, 1);
    const merged = mergeNativeRecords([{ dropped: 0, records: trace.records }]);
    const rows = traceRows({
      plan: plan("browsing", 1),
      observation: trace.observation,
      log,
      native: merged,
      runs,
      a3Reads: trace.a3Reads,
      startSeals: { 0: pair(0, CURRENT), 1: pair(1, CURRENT) },
      d2aMode: "restricted",
      ids: { revisions: { "rev-1": "rev-1" } },
      expectedContribution: null,
    });
    const result = classifyFollowUp(rows[0], { context: "trace" });
    assert.equal(rows[0].followUp.child, null, String(withOutside));
    assert.equal(result.x.X6, "no-child");
    assert.equal(result.x.X10, undefined, JSON.stringify(result.x));
    assert.equal(
      rows[0].followUp.parent.publishCount,
      1,
      "the other Scene's commit is not this generation's",
    );
    // The other Scene's loading commit is not this query's loading switch,
    // and the window ends at the move (no notice from the other Scene's stay).
    assert.equal(rows[0].followUp.loading.switched, false);
    assert.deepEqual(rows[0].followUp.notices, []);
    assert.equal(result.x.X3, "no-notice");
  }
});

test("レビュー P3 (a): query の場面でない seed つきの fetch も Q の外に数える", () => {
  const trace = editingTrace(1);
  const counts = traceRequeries({
    observation: {
      ...trace.observation,
      fetches: [
        ...trace.observation.fetches,
        {
          seq: 70,
          sceneId: OTHER,
          seed: SEED,
          refreshTrigger: null,
          calledAt: 11_000,
        },
      ],
    },
    parentSeqs: [1],
    querySceneId: SCENE,
  }).counts;
  assert.equal(counts["outside-q"], 1);
  assert.equal(counts.unattributed, 0);
});

test("レビュー P2-1: 封印の読取は seal-read の event として流れに残り、密度の規則（commit と query の間に harness の操作を足さない）を破らない", () => {
  const trace = editingTrace(2);
  const log = [
    ...trace.log.slice(0, 3),
    { op: "seal-read", phase: "before", index: 1, at: 12_610 },
    trace.log[3],
  ];
  const events = traceEvents({
    plan: plan("editing", 1),
    observation: trace.observation,
    log,
    parentSeqs: [1, 3],
  });
  assert.ok(events.some((row) => row.type === "seal-read"));
  const commitAt = events.findIndex((row) => row.type === "autosave-commit");
  const queryAt = events.findLastIndex(
    (row) => row.type === "query" && row.trigger === "user-operation",
  );
  const sealAt = events.findIndex((row) => row.type === "seal-read");
  assert.ok(commitAt < sealAt && sealAt < queryAt);
  const runs = pollRuns(trace.events, 9_000, 18_000, 1);
  const run = summarizeTraceRun({
    plan: plan("editing", 1),
    rows: rowsOf(trace, 2, runs),
    events,
    fixedGraphMode: "restricted",
  });
  assert.deepEqual(run.events.errors, []);
});

test("レビュー P2-2: stall か defects があれば、Q が 200 以上でも trace の status と summary は invalid（明示の欄）", () => {
  const n = 200;
  const trace = editingTrace(n);
  const runs = pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  // 201 planned (S2), 200 observed before a stall.
  const longPlan = plan("editing", n);
  const rows = rowsOf(trace, n, runs, { plan: longPlan });
  const events = traceEvents({
    plan: longPlan,
    observation: trace.observation,
    log: trace.log,
    parentSeqs: rows.map((_, at) => 2 * at + 1),
  });
  const stalled = summarizeTraceRun({
    plan: longPlan,
    rows,
    events,
    fixedGraphMode: "restricted",
    stalled: {
      seq: 600,
      op: "confirm-autosave-commit",
      reason: "no-autosave-commit",
    },
  });
  assert.equal(stalled.status, "invalid");
  assert.equal(stalled.summary.status, "invalid");
  assert.match(stalled.summary.invalid.join("\n"), /trace-stalled/u);
  assert.match(stalled.statusReasons.join("\n"), /the plan has 201/u);
  // Without the stall and with the plan complete it is valid.
  const complete = summarizeTraceRun({
    plan: plan("editing", n - 1),
    rows,
    events,
    fixedGraphMode: "restricted",
  });
  assert.equal(complete.status, "valid");
  assert.deepEqual(complete.statusReasons, []);
});

test("レビュー P3 (e): 親が結果を持たない query は throw せず、その query の defect として行に残す", () => {
  const trace = editingTrace(2);
  trace.observation.fetches.find((row) => row.seq === 3).result = null;
  const runs = pollRuns(trace.events, 9_000, 18_000, 1);
  const rows = rowsOf(trace, 2, runs, { plan: plan("editing", 1) });
  assert.equal(rows[1].followUp, null);
  assert.match(rows[1].rowError, /R7 record could not be built/u);
  assert.equal(rows[0].followUp.issuedVia, "product-hook");
});

test("レビュー P1-1: 移動の記録が無くても、窓の中の別の場面の fetch と commit は query の行に入らない（場面での絞込み）", () => {
  const trace = editingTrace(2, { 0: { child: false } });
  trace.observation.fetches.push({
    seq: 60,
    sceneId: OTHER,
    seed: null,
    refreshTrigger: null,
    rawOnly: false,
    queryGeneration: 9,
    calledAt: 12_500,
    resolvedAt: 12_560,
    failed: false,
    result: k64FetchResult({
      timing: { tFetchMs: 12_500, tRawReadyMs: 12_540, tReturnMs: 12_559 },
    }),
  });
  trace.observation.api.push({
    ...k64Api("related_scenes_begin", 12_501, 12_510),
    id: 900,
  });
  trace.observation.commits.push(
    { at: 12_502, fetchSeq: null, loading: true, display: null },
    { at: 12_561, fetchSeq: 60, loading: false, display: "harbor" },
    // A result the hook built itself for the other Scene (fetchSeq -1).
    { at: 12_562, fetchSeq: -1, loading: false, display: "harbor-built" },
  );
  const runs = pollRuns(trace.events, 9_000, 18_000, 1);
  const rows = rowsOf(trace, 2, runs, {
    plan: plan("editing", 1),
    startSeals: { 0: pair(0, CURRENT), 1: pair(1, CURRENT) },
  });
  const result = classifyFollowUp(rows[0], { context: "trace" });
  assert.equal(rows[0].followUp.child, null);
  assert.equal(result.x.X6, "no-child");
  assert.equal(result.x.X10, undefined, JSON.stringify(result.x));
  assert.equal(rows[0].followUp.loading.switched, false);
  // Not counted as a second display of the parent's generation (N1).
  assert.equal(rows[0].followUp.parent.publishCount, 1);
  assert.deepEqual(result.violations, []);
});

test("再レビュー P2: 移動の後に出た、この場面の世代の commit も混入の観測に入る（子の二度目の公開が N32 として検出される）", () => {
  const trace = editingTrace(2);
  const log = [
    trace.log[0],
    { op: "navigate", sceneId: OTHER, at: 12_100 },
    { op: "navigate", sceneId: SCENE, at: 12_900 },
    trace.log.at(-1),
  ];
  // Query 0's child (fetch seq 2) shown again 100 ms after the move.
  trace.observation.commits.push({
    at: 12_200,
    fetchSeq: 2,
    loading: false,
    display: "late-child-0",
  });
  const runs = pollRuns(trace.events, 9_000, 18_000, 1);
  const merged = mergeNativeRecords([{ dropped: 0, records: trace.records }]);
  const rows = traceRows({
    plan: plan("browsing", 1),
    observation: trace.observation,
    log,
    native: merged,
    runs,
    a3Reads: trace.a3Reads,
    startSeals: { 0: pair(0, CURRENT), 1: pair(1, CURRENT) },
    d2aMode: "restricted",
    ids: { revisions: { "rev-1": "rev-1" } },
    expectedContribution: null,
  });
  assert.equal(rows[0].followUp.child.publishCount, 2);
  const result = classifyFollowUp(rows[0], { context: "trace" });
  assert.ok(
    result.violations.includes("N32:child-published-more-than-once"),
    JSON.stringify(result.violations),
  );
});

test("再レビュー P3: 読取の件数が累積の dropped と最後の読取の件数に足りなければ取りこぼし。容量を超えても毎 cycle 読めば取りこぼしではない", () => {
  const rec = (seq) => k64NativeRecord({ seq });
  const reads = [];
  const log = [];
  for (let seq = 0; seq < 1500; seq++) {
    log.push(rec(seq));
    if (log.length > 1024) log.shift();
    if (seq % 50 === 49)
      reads.push({
        dropped: Math.max(0, seq + 1 - 1024),
        records: [...log],
      });
  }
  const every = mergeNativeRecords(reads);
  assert.equal(every.records.length, 1500);
  assert.equal(every.lost, false);
  // Read only at the start (empty) and at the end: 476 were pushed out.
  const sparse = mergeNativeRecords([
    { dropped: 0, records: [] },
    reads.at(-1),
  ]);
  assert.equal(sparse.lost, true);
  assert.equal(sparse.missing, 476);
});

/** DR-CP4-V-2: a Native record after the trace's last query (another begin). */
function trailingRecord(atMs, seq = 0) {
  return k64NativeRecord({
    seq,
    tBeginNs: ns(atMs),
    tReturnedNs: ns(atMs + 0.02),
    startSlot: {
      kind: "suspended",
      readyFresh: false,
      preparesReady: 1,
      readyGeneration: 8,
    },
    begin: "unavailable",
    reason: "registration-unavailable",
    ticket: null,
  });
}

function withRecords(trace, records) {
  return {
    ...trace,
    records: records.map((record, at) => ({ ...record, seq: at + 1 })),
  };
}

/**
 * The runner's Native reads of a synthetic trace (DR-CP4-V-3): one 1 ms after
 * each counted query's cycle end and one 1,000 ms after `observedUntil`
 * (after the export), each with the records begun by then and its `clockNs`
 * (the synthetic Native clock equals the renderer's).
 */
function cycleReads(trace, records = trace.records) {
  const read = (atMs) => ({
    dropped: 0,
    clockNs: ns(atMs),
    records: records.filter((record) => record.tBeginNs <= ns(atMs)),
  });
  return [
    ...trace.log
      .filter((row) => Number.isInteger(row.parentSeq))
      .map((entry) => read(entry.cycleEnd.at + 1)),
    read(trace.observation.observedUntil + 1_000),
  ];
}

test("DR-CP4-V-2: 観測の窓が閉じた後に始まった末尾の Native の記録だけを整列から除き、件数・seq・種別・時間を開示し、行は defect にならない", () => {
  const trace = editingTrace(3);
  const runs = pollRuns(trace.events, 9_000, 18_000, 1);
  // observedUntil は 19,000 ms。末尾の begin は窓の 200 ms 後。
  const late = withRecords(trace, [...trace.records, trailingRecord(19_200)]);
  const merged = mergeNativeRecords(cycleReads(late));
  const aligned = traceAlignment({
    observation: late.observation,
    native: merged,
    log: late.log,
  });
  assert.equal(aligned.aligned, true, aligned.reason);
  assert.equal(aligned.seededBegins, 6);
  assert.equal(aligned.records, 7);
  const excluded = aligned.excludedAfterWindow;
  assert.equal(excluded.rule, "DR-CP4-V-2");
  assert.equal(excluded.count, 1);
  assert.equal(excluded.lastPairedSeq, 6);
  assert.equal(excluded.observedUntil, 19_000);
  assert.deepEqual(
    excluded.records.map((row) => [
      row.seq,
      row.begin,
      row.reason,
      row.startSlot,
    ]),
    [[7, "unavailable", "registration-unavailable", "suspended"]],
  );
  // 直前の整列済みの記録（最後の子の begin、16,069 ms）からの時間。
  assert.ok(Math.abs(excluded.records[0].afterLastPairedMs - 3_131) < 1e-6);
  // 時計の差の範囲 [-0.5, 0.5] ms の上限で見ても窓の後。
  assert.deepEqual(excluded.clockBracketMs, { lower: -0.5, upper: 0.5 });
  // DR-CP4-V-3: 読取の範囲と交わり、除外は交わりの上限で判定する。
  assert.deepEqual(excluded.clockRangeMs, { lower: -0.5, upper: 0.5 });
  assert.equal(aligned.clock.readClockReason, null);
  assert.ok(aligned.clock.readClockMs.upper <= 1 + 1e-9);
  assert.ok(
    Math.abs(excluded.records[0].afterObservedUntilMsAtLeast - 199.5) < 1e-6,
  );
  // 受領書の形には対応の Map を入れない。
  const disclosed = alignmentDisclosure(aligned);
  assert.equal(disclosed.recordOf, undefined);
  assert.equal(disclosed.excludedAfterWindow.count, 1);
  assert.doesNotThrow(() => JSON.stringify(disclosed));
  // 行は窓の内側の一対一の対応で作られ、除いた記録を使わない。
  const rows = rowsOf(late, 3, runs, { native: merged });
  for (const row of rows) {
    assert.equal(row.rowError, undefined);
    assert.deepEqual(row.followUp.nativeBegins, ["pending", "cached"]);
  }
  assert.equal(rows[2].followUp.boundary.toSeq, 6);
  // 件数が合うときは従来どおり（除外なし）。
  const exact = alignSeededBegins({
    observation: trace.observation,
    native: mergeNativeRecords([{ dropped: 0, records: trace.records }]),
  });
  assert.equal(exact.aligned, true);
  assert.equal(exact.excludedAfterWindow, null);
});

test("DR-CP4-V-2: 窓の内側の不一致は defect のまま（末尾の記録が窓の内、窓の内側の余分、順序のずれ、記録の不足、取りこぼし、observedUntil なし）", () => {
  const trace = editingTrace(3);
  const runs = pollRuns(trace.events, 9_000, 18_000, 1);
  const check = (records, pattern, observation = trace.observation) => {
    const native = mergeNativeRecords(
      cycleReads(trace, withRecords(trace, records).records),
    );
    const aligned = traceAlignment({ observation, native, log: trace.log });
    assert.equal(aligned.aligned, false);
    assert.equal(aligned.excludedAfterWindow, null);
    assert.match(aligned.reason, pattern);
    assert.equal(aligned.recordOf.size, 0);
    return native;
  };
  // 末尾の記録が窓の内（観測の終わりの 100 ms 前）。
  const inside = check(
    [...trace.records, trailingRecord(18_900)],
    /6 seeded begins, 7 records \(the trailing records \[7\] are not after the observation window\)/u,
  );
  // 時計の範囲の上限ちょうどの境界（下限 = observedUntil）は窓の外と言えない。
  check(
    [...trace.records, trailingRecord(19_000.5)],
    /not after the observation window/u,
  );
  // 窓の内側に renderer の呼出しの無い begin がある（対応がずれ、範囲が空）。
  const middle = [...trace.records];
  middle.splice(2, 0, trailingRecord(13_005));
  check(middle, /no consistent clock range/u);
  // 先頭に余分がある（すべての組が 1 つずれる）。
  check(
    [trailingRecord(9_000), ...trace.records],
    /no consistent clock range/u,
  );
  // renderer の begin に対応する記録が無い（不足）。
  check(trace.records.slice(0, 5), /^6 seeded begins, 5 records$/u);
  // observedUntil の無い観測では除けない。
  const { observedUntil: _drop, ...noUntil } = trace.observation;
  check(
    [...trace.records, trailingRecord(19_200)],
    /no observedUntil/u,
    noUntil,
  );
  // 取りこぼし（seq の欠け）は件数より先に整列の失敗。
  const gap = mergeNativeRecords([
    {
      dropped: 0,
      records: [
        ...withRecords(trace, trace.records).records,
        { ...trailingRecord(19_200), seq: 9 },
      ],
    },
  ]);
  const lost = alignSeededBegins({
    observation: trace.observation,
    native: gap,
  });
  assert.equal(lost.aligned, false);
  assert.match(lost.reason, /lost records/u);
  // 行は従来どおり全行が defect row（R7 を欠く）。
  const rows = traceRows({
    plan: plan("editing", 2),
    observation: trace.observation,
    log: trace.log,
    native: inside,
    runs,
    a3Reads: trace.a3Reads,
    d2aMode: "restricted",
    ids: { revisions: { "rev-1": "rev-1" } },
    expectedContribution: null,
  });
  for (const row of rows) {
    assert.equal(row.followUp, null);
    assert.match(row.rowError, /the Native records are not aligned/u);
  }
});

test("DR-CP4-V-2: resolver を渡すと子の F6 は材料の Revision の単位（material-revision）で、Q=200 の K6/4 の読みは F-6 で無効にならない。渡さなければ preview の単位のまま", () => {
  const n = 200;
  const trace = editingTrace(n);
  const runs = pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  const longPlan = plan("editing", n - 1);
  const seen = [];
  const materialContribution = (paths) => {
    seen.push(paths);
    return {
      basis: "material-revision",
      contribution: true,
      observed: [],
      matched: ["graph-only:dev-added"],
      unresolvedEdges: 0,
    };
  };
  const rows = rowsOf(trace, n, runs, {
    plan: longPlan,
    materialContribution,
  });
  assert.equal(seen.length, n);
  for (const row of rows) {
    assert.equal(row.followUp.child.contributionBasis, "material-revision");
    assert.equal(row.followUp.child.expectedContribution, true);
    assert.deepEqual(row.followUp.child.materialRevision.matched, [
      "graph-only:dev-added",
    ]);
  }
  const events = traceEvents({
    plan: longPlan,
    observation: trace.observation,
    log: trace.log,
    parentSeqs: rows.map((_, at) => 2 * at + 1),
  });
  const k64 = summarizeTraceRun({
    plan: longPlan,
    rows,
    events,
    fixedGraphMode: "restricted",
    candidate: ratification5(),
    candidateHead: "e".repeat(40),
  });
  assert.doesNotMatch((k64.summary.invalid ?? []).join("\n"), /DR-CP4-F-6/u);
  assert.equal(
    k64.summary.status,
    "valid",
    JSON.stringify(k64.summary.invalid),
  );
  // resolver が無ければ（dev preview）preview の単位。
  const preview = rowsOf(
    editingTrace(2),
    2,
    pollRuns(editingTrace(2).events, 9_000, 18_000, 1),
  );
  assert.equal(
    preview[0].followUp.child.contributionBasis,
    "scene-level-preview",
  );
});

test("DR-CP4-V-2: resolver の期待する (Revision, edge) の組が trace の file の材料と同じでなければ [precheck]", () => {
  const tracePlan = {
    expectedMaterials: [
      { revisionId: "r-a", edgeIds: ["e-a"] },
      { revisionId: "r-b", edgeIds: ["e-b"] },
    ],
  };
  const expected = [
    { kind: "graph-only", sceneId: "s-a", pairs: ["r-a|e-a"] },
    { kind: "path-attachment", sceneId: "s-b", pairs: ["r-b|e-b"] },
  ];
  assert.deepEqual(assertTraceMaterialsMatch({ plan: tracePlan, expected }), [
    "r-a|e-a",
    "r-b|e-b",
  ]);
  for (const other of [
    [expected[0]],
    [
      ...expected,
      { kind: "path-attachment", sceneId: "s-c", pairs: ["r-c|e-c"] },
    ],
    [{ ...expected[0], pairs: ["r-a|e-x"] }, expected[1]],
  ])
    assert.throws(
      () => assertTraceMaterialsMatch({ plan: tracePlan, expected: other }),
      /\[precheck\] DR-CP4-V-2/u,
    );
  assert.throws(
    () =>
      assertTraceMaterialsMatch({
        plan: { expectedMaterials: [] },
        expected: [],
      }),
    /\[precheck\]/u,
  );
});

// ---- DR-CP4-V-3 (rule P-b): counted parents cancelled before their begin --

/**
 * Makes counted query `index` of an `editingTrace` a parent the product
 * cancelled before its begin (as #48 of the formal editing trace): the fetch
 * returns `cancelled` / `not-started` 1.2 ms after its call, 4 ms after an
 * `index-ready` notice, with no API row, no display and no Native record. Its
 * former child stays as the product's re-query (no trigger mark), or goes
 * (`requery: false`, as #200 whose re-query came after the observation).
 */
function cancelParent(trace, index, { requery = true } = {}) {
  const B = 10_000 + index * 3_000;
  const p = 2 * index + 1;
  const c = 2 * index + 2;
  const observation = trace.observation;
  const parent = observation.fetches.find((row) => row.seq === p);
  parent.resolvedAt = B + 1.2;
  parent.result = {
    ...parent.result,
    status: "cancelled",
    rawStatus: "not-started",
    resultKind: "raw",
    irStatus: "unavailable",
    irReason: "invalidated",
    completion: null,
    graphOutcome: null,
    graph: null,
    initialSnapshot: null,
    rawSceneIds: [],
    irSceneIds: [],
    finalSceneIds: [],
    timing: {
      tFetchMs: B,
      tRawReadyMs: null,
      tReturnMs: B + 1.2,
      refreshTrigger: null,
      graphWindowMs: null,
      native: null,
    },
  };
  const parentWindow = (at) => at >= B && at < B + 68;
  const childWindow = (at) => at >= B + 68 && at < B + 100;
  observation.api = observation.api.filter(
    (row) =>
      !parentWindow(row.calledAt) && (requery || !childWindow(row.calledAt)),
  );
  observation.commits = observation.commits.filter(
    (row) => row.fetchSeq !== p && (requery || row.fetchSeq !== c),
  );
  observation.notices = [
    ...observation.notices.filter((row) => !parentWindow(row.at)),
    { kind: "index-ready", at: B - 4 },
  ];
  const drop = new Set([ns(B + 15), ...(requery ? [] : [ns(B + 69)])]);
  trace.records = trace.records
    .filter((record) => !drop.has(record.tBeginNs))
    .map((record, at) => ({ ...record, seq: at + 1 }));
  trace.events = trace.events.filter(
    (event) => event.at !== ns(B + 15) && event.at !== ns(B + 64),
  );
  if (requery)
    observation.fetches.find((row) => row.seq === c).refreshTrigger = null;
  else observation.fetches = observation.fetches.filter((row) => row.seq !== c);
  return trace;
}

const STUB_RESOLVER = () => ({
  basis: "material-revision",
  contribution: true,
  observed: [],
  matched: ["graph-only:dev-added"],
  unresolvedEdges: 0,
});

test("DR-CP4-V-3: begin の前に取り消された親は defect にせず Q に数え、U に入れない。K6/2 で失効 (i)、K6/4 で X12、trace は valid。再 query は Q の外で index-ready に帰属し、受領書に開示する", () => {
  const n = 200;
  const trace = editingTrace(n);
  cancelParent(trace, 5);
  cancelParent(trace, 9);
  cancelParent(trace, n - 1, { requery: false });
  const runs = pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  const longPlan = plan("editing", n - 1);
  // 開始時の封印は全件 current（取り消された親も current でも U に入らない）。
  const startSeals = Object.fromEntries(
    Array.from({ length: n }, (_, at) => [at, pair(at, CURRENT)]),
  );
  const rows = rowsOf(trace, n, runs, {
    plan: longPlan,
    materialContribution: STUB_RESOLVER,
    startSeals,
  });
  assert.deepEqual(
    rows.filter((row) => row.rowError).map((row) => row.rowError),
    [],
  );
  const row = rows[5];
  assert.equal(row.queryId, `${longPlan.traceId}#5`);
  assert.deepEqual(row.snapshot, {
    usable: false,
    reason: "no-native-begin:cancelled-before-begin",
    chronicleIndexUsable: null,
    source: "start-seal",
  });
  assert.deepEqual(row.graph, {
    outcome: "cancelled",
    reason: "cancelled-before-begin",
    source: null,
    joined: false,
    arrivedAt: null,
    revalidation: null,
    edgeCount: null,
    busyCause: null,
  });
  assert.equal(row.irOutcome, "not-started");
  assert.equal(row.a3AtStart.eligible, true);
  assert.equal(row.startSeal.state, "current");
  assert.equal(row.startSeal.reads.after.read, "ok");
  assert.equal(row.tRawReady, row.tReturn);
  assert.equal(row.tRawReadyBasis, "t-return:raw-not-started");
  assert.deepEqual(row.followUp, {
    issuedVia: "product-hook",
    parent: {
      generation: 1,
      queryGeneration: 110,
      sceneId: SCENE,
      seed: SEED,
      calledAt: 25_000,
      resolvedAt: 25_001.2,
      publishCount: 0,
      cancelledBeforeBegin: true,
    },
    nativeBegins: [],
    child: null,
    requerySeq: 12,
  });
  assert.equal(lapseKind(row, false), "i-b-seal");
  const result = classifyFollowUp(row, { context: "trace" });
  assert.equal(result.x.X12, "cancelled-before-begin");
  assert.equal(Object.hasOwn(result.x, "X10"), false);
  // 再 query は Q の外。直前の begin に至った fetch から見て index-ready。
  const parentSeqs = rows.map((_, at) => 2 * at + 1);
  const cancelledParentSeqs = cancelledParentSeqsOf(rows);
  assert.deepEqual(cancelledParentSeqs, [11, 19, 399]);
  const requeries = traceRequeries({
    observation: trace.observation,
    parentSeqs,
    cancelledParentSeqs,
  });
  assert.equal(requeries.counts["index-ready"], 2);
  assert.equal(requeries.counts.unattributed, 0);
  // 印を渡さなければ従来の帰属（直前の fetch＝取り消された親から見る）。
  assert.equal(
    traceRequeries({ observation: trace.observation, parentSeqs }).counts
      .unattributed,
    2,
  );
  const events = traceEvents({
    plan: longPlan,
    observation: trace.observation,
    log: trace.log,
    parentSeqs,
    cancelledParentSeqs,
  });
  assert.equal(
    events.filter((event) => event.trigger === "index-ready-requery").length,
    2,
  );
  const k62 = summarizeTraceRun({
    plan: longPlan,
    rows,
    events,
    fixedGraphMode: "restricted",
  });
  assert.deepEqual(k62.defects, []);
  assert.equal(k62.summary.status, "valid", JSON.stringify(k62.summary));
  assert.equal(k62.summary.Q, 200);
  assert.equal(k62.summary.U, 197);
  assert.equal(k62.summary.lapse["i-b-seal"], 3);
  const k64 = summarizeTraceRun({
    plan: longPlan,
    rows,
    events,
    fixedGraphMode: "restricted",
    candidate: ratification5(),
    candidateHead: "e".repeat(40),
  });
  assert.equal(k64.summary.status, "valid", JSON.stringify(k64.summary));
  assert.equal(k64.summary.regime, "k64");
  assert.equal(k64.summary.Q, 200);
  assert.equal(k64.summary.U, 197);
  assert.equal(k64.summary.x.X12, 3);
  assert.equal(k64.summary.lapse["i-b-seal"], 3);
  // 受領書の開示。
  const disclosed = cancelledParentsDisclosure(rows);
  assert.equal(disclosed.count, 3);
  assert.deepEqual(disclosed.rows[0], {
    queryId: `${longPlan.traceId}#5`,
    rule: "DR-CP4-V-3",
    parentSeq: 11,
    calledAt: 25_000,
    resolvedAt: 25_001.2,
    indexReadyAt: 24_996,
    afterIndexReadyMs: 4,
    startSeal: "current",
    requery: { seq: 12, calledAt: 25_068, began: true },
    requeryOutsideWindow: false,
    windowEnd: 28_000,
    observedUntil: 610_000,
  });
  assert.equal(disclosed.rows[2].requery, null);
  assert.equal(disclosed.rows[2].requeryOutsideWindow, true);
  assert.deepEqual(lapseIBreakdown(k64.summary, rows), {
    "i-b-seal": 3,
    cancelledBeforeBegin: 3,
    other: 0,
    "i-chronicle-stop": 0,
  });
  assert.equal(lapseIBreakdown({ status: "invalid" }, rows), null);
  assert.doesNotThrow(() => JSON.stringify(disclosed));
});

test("DR-CP4-V-3: 他の形（begin の行があるのに記録が無い、completed、公開済み、A3 なし、rawStatus が not-started でない、整列の失敗）は従来どおり defect", () => {
  const n = 12;
  const runsOf = (trace) =>
    pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  const defectAt = (trace, at, pattern, overrides = {}) => {
    const rows = rowsOf(trace, n, runsOf(trace), overrides);
    assert.equal(rows[at].followUp, null);
    assert.equal(rows[at].cancelledBeforeBegin, undefined);
    assert.match(rows[at].rowError, pattern);
    return rows;
  };
  const noRecord = /the parent's begin has no Native record/u;
  // begin の行がある（記録だけが無い）。
  const withBegin = cancelParent(editingTrace(n), 5);
  withBegin.observation.api.push({
    ...k64Api("related_scenes_begin", 25_000.5, 25_001),
    id: 9_999,
  });
  // 記録の数が begin の数に足りず整列が失敗する（全行が defect）。
  const unaligned = rowsOf(withBegin, n, runsOf(withBegin));
  assert.ok(unaligned.every((row) => /not aligned/u.test(row.rowError)));
  // 製品の返却が completed（取消しでない）。
  const completed = cancelParent(editingTrace(n), 5);
  completed.observation.fetches.find((row) => row.seq === 11).result.status =
    "completed";
  defectAt(completed, 5, noRecord);
  // Raw が始まった後の取消し。
  const started = cancelParent(editingTrace(n), 5);
  started.observation.fetches.find((row) => row.seq === 11).result.rawStatus =
    "raw-ready";
  defectAt(started, 5, noRecord);
  // 親の世代の表示が commit された（公開済み）。
  const published = cancelParent(editingTrace(n), 5);
  published.observation.commits.push({
    at: 25_001.5,
    fetchSeq: 11,
    loading: false,
    display: "parent-5",
  });
  defectAt(published, 5, noRecord);
  // 開始時の A3 の読取が無い。
  const noA3 = cancelParent(editingTrace(n), 5);
  delete noA3.a3Reads[11];
  defectAt(noA3, 5, noRecord);
  // 取り消された親の無い trace の行は変わらない。
  const plain = editingTrace(n);
  const plainRows = rowsOf(plain, n, runsOf(plain));
  assert.ok(plainRows.every((row) => row.cancelledBeforeBegin === undefined));
  assert.deepEqual(cancelledParentSeqsOf(plainRows), []);
  assert.equal(cancelledParentsDisclosure(plainRows).count, 0);
});

// ---- DR-CP4-V-3 (レビュー P2-2): the pairing against the Native reads' clock

/**
 * Uniformly spaced seeded begins (one per counted query, `G` ms apart; the
 * Native clock equals the renderer's), the runner log (cycle end 50 ms after
 * each call, the next edit's caret 100 ms after) and the reads (75 ms after
 * each call, and 10 ms after `observedUntil`).
 */
function uniformTrace(
  n,
  { gap = 1_000, extraFront = false, dropLast = false } = {},
) {
  const fetches = [];
  const api = [];
  const log = [];
  let records = [];
  const at = (index) => 10_000 + gap * index;
  for (let index = 0; index < n; index++) {
    const t = at(index);
    fetches.push({
      seq: index + 1,
      seed: SEED,
      sceneId: SCENE,
      calledAt: t,
      resolvedAt: t + 10,
    });
    api.push({
      id: index,
      cmd: "related_scenes_begin",
      calledAt: t + 0.1,
      resolvedAt: t + 5,
    });
    records.push({
      tBeginNs: ns(t + 0.2),
      tReturnedNs: ns(t + 4.9),
      begin: "pending",
    });
    log.push(
      {
        op: "product-query",
        index,
        parentSeq: index + 1,
        calledAt: t,
        cycleEnd: { reason: "t-show-elapsed", at: t + 50 },
      },
      { op: "edit", caretAt: t + 100, startedAt: t + 101, endedAt: t + 110 },
    );
  }
  if (extraFront)
    records.unshift({
      tBeginNs: ns(at(0) - gap + 0.2),
      tReturnedNs: ns(at(0) - gap + 4.9),
      begin: "unavailable",
    });
  if (dropLast) records.pop();
  records = records.map((record, seq) => ({ ...record, seq: seq + 1 }));
  const observedUntil = at(n - 1) + 300;
  const read = (ms) => ({
    dropped: 0,
    clockNs: ns(ms),
    records: records.filter((row) => row.tBeginNs <= ns(ms)),
  });
  const reads = [
    ...Array.from({ length: n }, (_, index) => read(at(index) + 75)),
    read(observedUntil + 10),
  ];
  return { observation: { fetches, api, observedUntil }, log, reads };
}

test("DR-CP4-V-3: 前方に余分な記録があって組が一様に 1 つずれた対応は、Native の読取の時計の範囲と交わらず整列の失敗（読取の範囲が無い M>N も失敗）", () => {
  const shifted = uniformTrace(6, { extraFront: true });
  const native = mergeNativeRecords(shifted.reads);
  const aligned = traceAlignment({ ...shifted, native });
  assert.equal(aligned.aligned, false);
  assert.match(
    aligned.reason,
    /6 seeded begins, 7 records \(the pairs' clock range \[-1000\.1.*does not meet the Native reads'/u,
  );
  assert.equal(aligned.excludedAfterWindow, null);
  assert.equal(aligned.recordOf.size, 0);
  // 組だけの範囲は無矛盾（V-2 の検査だけでは通っていた）。
  assert.ok(aligned.clock.pairsMs.lower <= aligned.clock.pairsMs.upper);
  // 読取の範囲は真の差（0）の付近。
  assert.ok(
    aligned.clock.readClockMs.lower <= 0 &&
      aligned.clock.readClockMs.upper >= 0,
  );
  // 読取の範囲が求められない（読取 1 回）M>N は除外しない。
  const single = alignSeededBegins({
    observation: shifted.observation,
    native: mergeNativeRecords([shifted.reads.at(-1)]),
    readClock: nativeReadClockRange({
      log: shifted.log,
      observation: shifted.observation,
      native: mergeNativeRecords([shifted.reads.at(-1)]),
    }),
  });
  assert.equal(single.aligned, false);
  assert.match(
    single.reason,
    /no independent clock range from the Native reads: 1 Native reads for 6 counted queries/u,
  );
  assert.equal(
    alignSeededBegins({ observation: shifted.observation, native }).aligned,
    false,
  );
  // 前方の余分に加えて最後の記録が無い（M = N で一様にずれる）。読取の範囲があれば失敗。
  const equal = uniformTrace(6, { extraFront: true, dropLast: true });
  const equalNative = mergeNativeRecords(equal.reads);
  const caught = traceAlignment({ ...equal, native: equalNative });
  assert.equal(caught.aligned, false);
  assert.match(
    caught.reason,
    /6 seeded begins, 6 records \(the pairs' clock range/u,
  );
  // 読取の範囲を渡さない単体の呼出しの M = N は従来どおり（件数と順序だけ）。
  assert.equal(
    alignSeededBegins({ observation: equal.observation, native: equalNative })
      .aligned,
    true,
  );
  // ずれの無い trace は通り、範囲を開示する。
  const plain = uniformTrace(6);
  const ok = traceAlignment({
    ...plain,
    native: mergeNativeRecords(plain.reads),
  });
  assert.equal(ok.aligned, true, ok.reason);
  assert.ok(ok.clock.rangeMs.lower <= 0.1 && ok.clock.rangeMs.upper >= -0.1);
  assert.deepEqual(alignmentDisclosure(ok).clock, ok.clock);
  // 窓の内側の余分（shift の反例）も従来どおり失敗。
  const inside = uniformTrace(6);
  const extra = {
    tBeginNs: ns(12_500),
    tReturnedNs: ns(12_500.1),
    begin: "unavailable",
  };
  const records = mergeNativeRecords(inside.reads).records;
  records.splice(3, 0, extra);
  const reseq = records.map((record, seq) => ({ ...record, seq: seq + 1 }));
  const insideReads = inside.reads.map((read) => ({
    ...read,
    records: reseq.filter((row) => row.tBeginNs <= read.clockNs),
  }));
  assert.equal(
    traceAlignment({ ...inside, native: mergeNativeRecords(insideReads) })
      .aligned,
    false,
  );
});

test("DR-CP4-V-3: Native の読取の時計の範囲は、読取の数が counted query の数＋1 でない、clockNs が無い、cycle end の時刻が無いときは求めない", () => {
  const plain = uniformTrace(3);
  const native = mergeNativeRecords(plain.reads);
  const range = nativeReadClockRange({ ...plain, native });
  assert.equal(range.reason, null);
  assert.equal(range.reads, 4);
  // 読取 i: clock = t+75、区間 [t+50, t+100] → [-25, 25]。最後: [−∞, 10]。
  assert.deepEqual(range.range, { lower: -25, upper: 10 });
  assert.match(
    nativeReadClockRange({
      ...plain,
      native: mergeNativeRecords(plain.reads.slice(1)),
    }).reason,
    /3 Native reads for 3 counted queries/u,
  );
  const noClock = plain.reads.map((read, at) =>
    at === 1 ? { ...read, clockNs: undefined } : read,
  );
  assert.match(
    nativeReadClockRange({ ...plain, native: mergeNativeRecords(noClock) })
      .reason,
    /read 1 has no clockNs/u,
  );
  const noEnd = plain.log.map((row) =>
    row.index === 2 ? { ...row, cycleEnd: { reason: "x", at: null } } : row,
  );
  assert.match(
    nativeReadClockRange({ ...plain, log: noEnd, native }).reason,
    /read 2 has no renderer time interval/u,
  );
  const { observedUntil: _drop, ...noUntil } = plain.observation;
  assert.match(
    nativeReadClockRange({ ...plain, observation: noUntil, native }).reason,
    /no observedUntil/u,
  );
});

// ---- DR-CP4-V-4: a fetch called after the cycle end is no child -----------

/**
 * Makes counted query `index` of an `editingTrace` the shape of the dev
 * rehearsal's #178: the parent was cancelled after its begin (`cancelled`,
 * `rawStatus: completed`, `graph-unavailable:cancelled`, never published),
 * the cycle ended with it (`parent-ended`), and the product's re-query (the
 * former child, no trigger mark, no Graph of its own) was called after the
 * cycle end and published once.
 */
function cancelAfterBegin(trace, index) {
  const B = 10_000 + index * 3_000;
  const p = 2 * index + 1;
  const c = 2 * index + 2;
  const observation = trace.observation;
  const parent = observation.fetches.find((row) => row.seq === p);
  parent.result = {
    ...parent.result,
    status: "cancelled",
    resultKind: "raw",
    irStatus: "unavailable",
    irReason: "cancelled",
    completion: { outcome: "cancelled", deadlineExceeded: false },
    graphOutcome: "graph-unavailable:cancelled",
    graph: null,
    irSceneIds: [],
    finalSceneIds: ["dev-a", "dev-b"],
  };
  observation.commits = observation.commits.filter((row) => row.fetchSeq !== p);
  observation.notices = observation.notices.filter(
    (row) => !(row.kind === "graph-ready" && row.at >= B && row.at < B + 100),
  );
  const child = observation.fetches.find((row) => row.seq === c);
  child.refreshTrigger = null;
  child.result = {
    ...child.result,
    graphOutcome: "graph-unavailable:registration-unavailable",
    graph: null,
    timing: { ...child.result.timing, refreshTrigger: null },
  };
  trace.log.find((row) => row.parentSeq === p).cycleEnd = {
    reason: "parent-ended",
    at: B + 61.5,
  };
  return trace;
}

const graphDisplay = (label) => JSON.stringify([label, [], { edges: 1 }]);

test("DR-CP4-V-4: cycle end の後に呼ばれた再 query は子にせず（v3 の #178 の形）、親の段（X11／X12）の失敗で E-6 にならず trace は valid。再 query は行と受領書に開示する", () => {
  const n = 200;
  const trace = cancelAfterBegin(editingTrace(n), 7);
  const runs = pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  const longPlan = plan("editing", n - 1);
  const rows = rowsOf(trace, n, runs, {
    plan: longPlan,
    materialContribution: STUB_RESOLVER,
  });
  assert.deepEqual(
    rows.filter((row) => row.rowError).map((row) => row.rowError),
    [],
  );
  const row = rows[7];
  assert.equal(row.followUp.child, null);
  assert.deepEqual(row.followUp.nativeBegins, ["pending"]);
  assert.equal(row.followUp.parent.publishCount, 0);
  assert.equal(row.followUp.parent.lateGraphInDisplay, false);
  assert.equal(row.sampleEnd.fetchesInMixWindow, 0);
  assert.deepEqual(row.requeryAfterCycleEnd, {
    rule: "DR-CP4-V-4",
    cycleEndAt: 31_061.5,
    rows: [
      {
        seq: 16,
        calledAt: 31_068,
        afterCycleEndMs: 6.5,
        refreshTrigger: null,
        publishCount: 1,
        lateGraphInDisplay: false,
      },
    ],
  });
  const result = classifyFollowUp(row, { context: "trace" });
  assert.equal(result.failedStage.stage, "parent");
  assert.equal(result.x.X11, "cancelled");
  assert.equal(result.x.X12, "graph-unavailable:cancelled");
  assert.equal(result.x.X6, "no-child");
  assert.equal(Object.hasOwn(result.x, "X10"), false);
  assert.deepEqual(result.violations, []);
  // ほかの行は子を持ったまま（cycle end の前の子は従来どおり）。
  for (const other of rows.filter((_, at) => at !== 7)) {
    assert.notEqual(other.followUp.child, null);
    assert.equal(Object.hasOwn(other, "requeryAfterCycleEnd"), false);
  }
  const parentSeqs = rows.map((_, at) => 2 * at + 1);
  const events = traceEvents({
    plan: longPlan,
    observation: trace.observation,
    log: trace.log,
    parentSeqs,
  });
  // 再 query は Q の外のまま（K6/2 手順 7）。
  assert.equal(
    traceRequeries({ observation: trace.observation, parentSeqs }).counts
      .unattributed,
    1,
  );
  const k64 = summarizeTraceRun({
    plan: longPlan,
    rows,
    events,
    fixedGraphMode: "restricted",
    candidate: ratification5(),
    candidateHead: "e".repeat(40),
  });
  assert.equal(k64.summary.status, "valid", JSON.stringify(k64.summary));
  assert.equal(k64.summary.regime, "k64");
  assert.equal(k64.summary.Q, 200);
  assert.equal(k64.summary.x.X12, 1);
  assert.deepEqual(k64.summary.violations, []);
  const k62 = summarizeTraceRun({
    plan: longPlan,
    rows,
    events,
    fixedGraphMode: "restricted",
  });
  assert.equal(k62.summary.status, "valid", JSON.stringify(k62.summary));
  assert.deepEqual(k62.summary.violations, []);
  const disclosed = requeryAfterCycleEndDisclosure(rows);
  assert.equal(disclosed.count, 1);
  assert.deepEqual(disclosed.rows[0], {
    queryId: `${longPlan.traceId}#7`,
    parentCancelledBeforeBegin: false,
    cycleEnd: { reason: "parent-ended", at: 31_061.5 },
    seq: 16,
    calledAt: 31_068,
    afterCycleEndMs: 6.5,
    refreshTrigger: null,
    publishCount: 1,
    lateGraphInDisplay: false,
  });
  assert.deepEqual(requeryAfterCycleEndViolations(rows), []);
});

test("DR-CP4-V-4: 残余（直さない）: 子が cycle end の前に呼ばれ commit が後の形は今のまま X10（child.publishedTimes）で、K6/4 の読みは E-6 で無効", () => {
  const n = 200;
  const trace = cancelAfterBegin(editingTrace(n), 7);
  // 子の呼出しを cycle end の前へ（commit は後のまま）。
  trace.observation.fetches.find((row) => row.seq === 16).calledAt = 31_061;
  const runs = pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  const longPlan = plan("editing", n - 1);
  const rows = rowsOf(trace, n, runs, {
    plan: longPlan,
    materialContribution: STUB_RESOLVER,
  });
  const row = rows[7];
  assert.equal(Object.hasOwn(row, "requeryAfterCycleEnd"), false);
  assert.notEqual(row.followUp.child, null);
  assert.equal(row.followUp.child.reactCommitAt, null);
  assert.equal(
    classifyFollowUp(row, { context: "trace" }).x.X10,
    "missing:child.publishedTimes",
  );
  const k64 = summarizeTraceRun({
    plan: longPlan,
    rows,
    events: traceEvents({
      plan: longPlan,
      observation: trace.observation,
      log: trace.log,
      parentSeqs: rows.map((_, at) => 2 * at + 1),
    }),
    fixedGraphMode: "restricted",
    candidate: ratification5(),
    candidateHead: "e".repeat(40),
  });
  assert.equal(k64.summary.status, "invalid");
  assert.match(
    k64.summary.invalid.join("\n"),
    /#7 lacks its R7 follow-up records/u,
  );
});

test("DR-CP4-V-4: cycle end の前の子は従来どおり。cycle end の後の 3 番目の fetch を足しても、その API 行と世代の commit（-1 を含む）を除いた行は足さない trace の行と同じ（開示の欄だけが増える）", () => {
  const n = 6;
  const plain = editingTrace(n);
  const withLate = editingTrace(n);
  const B = 10_000 + 2 * 3_000;
  withLate.observation.fetches.push({
    seq: 5_000,
    sceneId: SCENE,
    queryGeneration: 999,
    refreshTrigger: null,
    seed: SEED,
    rawOnly: false,
    calledAt: B + 500,
    resolvedAt: B + 530,
    failed: false,
    result: k64FetchResult({
      graphOutcome: "graph-unavailable:registration-unavailable",
      timing: { tFetchMs: B + 500, tRawReadyMs: B + 520, tReturnMs: B + 529 },
    }),
  });
  withLate.observation.api.push(
    { ...k64Api("related_scenes_begin", B + 501, B + 510), id: 9_001 },
    { ...k64Api("related_scenes_continue", B + 520.5, B + 528), id: 9_002 },
  );
  withLate.observation.commits.push(
    { at: B + 531, fetchSeq: 5_000, loading: false, display: "late-a" },
    // A result no fetch returned: its generation is the late fetch's.
    { at: B + 540, fetchSeq: -1, loading: false, display: "late-a" },
  );
  // The late fetch's begin has its Native record (in order, after the child's).
  const late = k64NativeRecord({
    tBeginNs: ns(B + 502),
    tReturnedNs: ns(B + 503),
    begin: "unavailable",
    reason: "registration-unavailable",
    ticket: null,
  });
  const at = withLate.records.findIndex((row) => row.tBeginNs > ns(B + 502));
  withLate.records.splice(at, 0, late);
  withLate.records.forEach((record, seq) => {
    record.seq = seq + 1;
  });
  // Its begin is left out of the counter events: the later rows' absolute
  // counters would move (their deltas would not), not what is compared here.
  const runsOf = (trace) =>
    pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  const plainRows = rowsOf(plain, n, runsOf(plain));
  const lateRows = rowsOf(withLate, n, runsOf(withLate));
  assert.deepEqual(
    lateRows.filter((row) => row.rowError).map((row) => row.rowError),
    [],
  );
  // The later rows' Native seqs move by the late begin's record only.
  const seqFree = (row) => ({
    ...row,
    followUp: {
      ...row.followUp,
      boundary: { ...row.followUp.boundary, fromSeq: null, toSeq: null },
    },
  });
  for (let index = 0; index < n; index++) {
    if (index === 2) continue;
    assert.deepEqual(
      index < 2 ? lateRows[index] : seqFree(lateRows[index]),
      index < 2 ? plainRows[index] : seqFree(plainRows[index]),
    );
  }
  const { requeryAfterCycleEnd, ...rest } = lateRows[2];
  assert.deepEqual(rest, plainRows[2]);
  assert.deepEqual(requeryAfterCycleEnd.rows, [
    {
      seq: 5_000,
      calledAt: B + 500,
      afterCycleEndMs: 500 - 96.5,
      refreshTrigger: null,
      publishCount: 1,
      lateGraphInDisplay: false,
    },
  ]);
  assert.notEqual(rest.followUp.child, null);
  assert.equal(
    classifyFollowUp(rest, { context: "trace" }).followUp,
    classifyFollowUp(plainRows[2], { context: "trace" }).followUp,
  );
});

test("DR-CP4-V-4: 除いた再 query の 2 回の公開は N32、遅れた Graph の表示は N29 の違反（K6/2・K6/4 の両方の要約）。-1 の commit は親の世代に帰属させない（N1 の偽陽性なし）", () => {
  const n = 200;
  const trace = cancelAfterBegin(editingTrace(n), 7);
  trace.observation.commits.push(
    { at: 31_097, fetchSeq: 16, loading: false, display: "child-7-again" },
    // A result no fetch returned, with Graph content: kept, it would be the
    // parent's generation (N1) once the re-query left the record.
    { at: 31_098, fetchSeq: -1, loading: false, display: graphDisplay("x") },
  );
  const runs = pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  const longPlan = plan("editing", n - 1);
  const rows = rowsOf(trace, n, runs, {
    plan: longPlan,
    materialContribution: STUB_RESOLVER,
  });
  const row = rows[7];
  assert.equal(row.followUp.parent.publishCount, 0);
  assert.equal(row.followUp.parent.lateGraphInDisplay, false);
  assert.deepEqual(classifyFollowUp(row, { context: "trace" }).violations, []);
  assert.equal(row.requeryAfterCycleEnd.rows[0].publishCount, 3);
  assert.equal(row.requeryAfterCycleEnd.rows[0].lateGraphInDisplay, true);
  const expected = [
    {
      queryId: `${longPlan.traceId}#7`,
      code: "N32:requery-after-cycle-end-published-more-than-once",
      seq: 16,
    },
    {
      queryId: `${longPlan.traceId}#7`,
      code: "N29:late-graph-in-requery-after-cycle-end-display",
      seq: 16,
    },
  ];
  assert.deepEqual(requeryAfterCycleEndViolations(rows), expected);
  const events = traceEvents({
    plan: longPlan,
    observation: trace.observation,
    log: trace.log,
    parentSeqs: rows.map((_, at) => 2 * at + 1),
  });
  for (const extra of [
    {},
    { candidate: ratification5(), candidateHead: "e".repeat(40) },
  ]) {
    const run = summarizeTraceRun({
      plan: longPlan,
      rows,
      events,
      fixedGraphMode: "restricted",
      ...extra,
    });
    assert.deepEqual(run.summary.violations, expected);
  }
  // 自分の Graph が窓（D）の後に届いて表示された再 query も N29。
  const own = cancelAfterBegin(editingTrace(n), 7);
  const requery = own.observation.fetches.find((row) => row.seq === 16);
  requery.result = {
    ...requery.result,
    graphOutcome: "graph-ready",
    graph: K64_CHILD_RESULT.graph,
  };
  own.observation.commits.find((row) => row.fetchSeq === 16).display =
    graphDisplay("own");
  const ownRows = rowsOf(own, n, pollRuns(own.events, 9_000, 610_000, 1), {
    plan: longPlan,
    materialContribution: STUB_RESOLVER,
  });
  assert.equal(ownRows[7].requeryAfterCycleEnd.rows[0].publishCount, 1);
  assert.equal(
    ownRows[7].requeryAfterCycleEnd.rows[0].lateGraphInDisplay,
    true,
  );
});

test("DR-CP4-V-4 × V-3: begin の前に取り消された親の再 query が cycle end の後なら、V-3 の開示はそのままで requeryAfterCycleEnd を足し、違反の検査を当てる（分類は X12 のまま）", () => {
  const n = 200;
  const trace = cancelParent(editingTrace(n), 5);
  trace.log.find((row) => row.parentSeq === 11).cycleEnd = {
    reason: "parent-ended",
    at: 25_001.5,
  };
  const runs = pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  const longPlan = plan("editing", n - 1);
  const rows = rowsOf(trace, n, runs, {
    plan: longPlan,
    materialContribution: STUB_RESOLVER,
  });
  const row = rows[5];
  assert.equal(row.followUp.requerySeq, 12);
  assert.deepEqual(row.cancelledBeforeBegin.requery, {
    seq: 12,
    calledAt: 25_068,
    began: true,
  });
  assert.equal(row.cancelledBeforeBegin.requeryOutsideWindow, false);
  assert.deepEqual(row.requeryAfterCycleEnd.rows, [
    {
      seq: 12,
      calledAt: 25_068,
      afterCycleEndMs: 66.5,
      // The result's own mark, as k64-record.mjs reads the child's.
      refreshTrigger: "graph-ready",
      publishCount: 1,
      lateGraphInDisplay: false,
    },
  ]);
  assert.equal(
    classifyFollowUp(row, { context: "trace" }).x.X12,
    "cancelled-before-begin",
  );
  assert.equal(
    requeryAfterCycleEndDisclosure(rows).rows[0].parentCancelledBeforeBegin,
    true,
  );
  assert.deepEqual(requeryAfterCycleEndViolations(rows), []);
  // 同じ行の cycle end が再 query の後なら（V-3 の試験の形）、欄は足さない。
  const before = cancelParent(editingTrace(n), 5);
  const beforeRows = rowsOf(
    before,
    n,
    pollRuns(before.events, 9_000, 610_000, 1),
    { plan: longPlan, materialContribution: STUB_RESOLVER },
  );
  assert.equal(Object.hasOwn(beforeRows[5], "requeryAfterCycleEnd"), false);
  const { requeryAfterCycleEnd, ...rest } = row;
  assert.ok(requeryAfterCycleEnd);
  assert.deepEqual(
    { ...rest, cycleEnd: null },
    { ...beforeRows[5], cycleEnd: null },
  );
  // 再 query の 2 回の公開は V-3 の行でも N32。
  trace.observation.commits.push({
    at: 25_097,
    fetchSeq: 12,
    loading: false,
    display: "child-5-again",
  });
  const twice = rowsOf(trace, n, runs, {
    plan: longPlan,
    materialContribution: STUB_RESOLVER,
  });
  assert.deepEqual(
    requeryAfterCycleEndViolations(twice).map((row) => row.code),
    ["N32:requery-after-cycle-end-published-more-than-once"],
  );
  const run = summarizeTraceRun({
    plan: longPlan,
    rows: twice,
    events: traceEvents({
      plan: longPlan,
      observation: trace.observation,
      log: trace.log,
      parentSeqs: twice.map((_, at) => 2 * at + 1),
      cancelledParentSeqs: cancelledParentSeqsOf(twice),
    }),
    fixedGraphMode: "restricted",
    candidate: ratification5(),
    candidateHead: "e".repeat(40),
  });
  assert.equal(run.summary.status, "valid", JSON.stringify(run.summary));
  assert.equal(run.summary.violations.length, 1);
});

test("DR-CP4-V-4 (レビュー P3): 取り消された親の前に begin に至った同じ場面の fetch が無いとき、再 query の帰属は古い index-ready の通知を拾わない（下限は場面の直前の fetch、無ければ親の呼出し）", () => {
  const fetch = (seq, calledAt, extra = {}) => ({
    seq,
    sceneId: SCENE,
    seed: SEED,
    refreshTrigger: null,
    calledAt,
    resolvedAt: calledAt + 1,
    result: null,
    ...extra,
  });
  const kindOf = (observation) =>
    traceRequeries({
      observation,
      parentSeqs: [1],
      querySceneId: SCENE,
      cancelledParentSeqs: [1],
    }).rows.find((row) => row.seq === 2).kind;
  // 取り消された親（seq 1）が場面の最初の fetch。通知はそれよりずっと前。
  const first = {
    fetches: [fetch(1, 1_000), fetch(2, 1_400)],
    api: [{ cmd: "related_scenes_begin", calledAt: 1_401 }],
    notices: [{ kind: "index-ready", at: 100 }],
  };
  assert.equal(kindOf(first), "unattributed");
  // 親と再 query の間の通知は従来どおり index-ready。
  assert.equal(
    kindOf({
      ...first,
      notices: [...first.notices, { kind: "index-ready", at: 1_200 }],
    }),
    "index-ready",
  );
  // begin に至らなかった同じ場面の前の fetch（seq 9、t=50）があれば、それから見る。
  const earlier = {
    ...first,
    fetches: [fetch(9, 50), ...first.fetches],
  };
  assert.equal(kindOf(earlier), "index-ready");
  assert.equal(
    kindOf({ ...earlier, notices: [{ kind: "index-ready", at: 10 }] }),
    "unattributed",
  );
  // begin に至った前の fetch があるときは V-3 のまま（それから見る）。
  assert.equal(
    kindOf({
      ...earlier,
      api: [{ cmd: "related_scenes_begin", calledAt: 51 }, ...earlier.api],
      notices: [{ kind: "index-ready", at: 60 }],
    }),
    "index-ready",
  );
});

// ---- DR-CP4-V-4 (レビュー P3): the cycle-end boundary of afterCycleEnd ----

/** Row `index` of an `editingTrace(n)` with its log's cycle end replaced. */
function rowWithCycleEnd(n, index, cycleEndOf) {
  const trace = editingTrace(n);
  const entry = trace.log.find((row) => row.index === index);
  const parent = trace.observation.fetches.find(
    (row) => row.seq === entry.parentSeq,
  );
  const child = trace.observation.fetches.find(
    (row) => row.seq === entry.parentSeq + 1,
  );
  const cycleEnd = cycleEndOf({ parent, child });
  if (cycleEnd === undefined) delete entry.cycleEnd;
  else entry.cycleEnd = cycleEnd;
  const runs = pollRuns(trace.events, 9_000, 10_000 + n * 3_000, 1);
  return { row: rowsOf(trace, n, runs)[index], parent, child };
}

test("DR-CP4-V-4 (レビュー P3): cycle end と同じ時刻に呼ばれた fetch は除かない（`>` の境界）。子のまま残り、再 query の開示は無い", () => {
  const { row, child } = rowWithCycleEnd(6, 2, ({ child }) => ({
    reason: "child-published",
    at: child.calledAt,
  }));
  assert.equal(row.rowError, undefined);
  assert.equal(Object.hasOwn(row, "requeryAfterCycleEnd"), false);
  assert.equal(row.followUp.child.queryGeneration, child.queryGeneration);
});

test("DR-CP4-V-4 (レビュー P3): cycle end の時刻が null／欠けなら、どの fetch も除かない（finite の guard）", () => {
  for (const cycleEndOf of [
    () => ({ reason: "child-published", at: null }),
    () => ({ reason: "child-published" }),
    () => null,
    () => undefined,
  ]) {
    const { row, parent, child } = rowWithCycleEnd(6, 2, cycleEndOf);
    assert.equal(Object.hasOwn(row, "requeryAfterCycleEnd"), false);
    assert.equal(row.followUp.parent.queryGeneration, parent.queryGeneration);
    assert.equal(row.followUp.child.queryGeneration, child.queryGeneration);
  }
});

test("DR-CP4-V-4 (レビュー P3): 親は cycle end より後に呼ばれても除外の対象にならない（除くのは親の後の fetch だけ）", () => {
  const { row, parent, child } = rowWithCycleEnd(6, 2, ({ parent }) => ({
    reason: "child-published",
    at: parent.calledAt - 1,
  }));
  assert.deepEqual(
    row.requeryAfterCycleEnd.rows.map((late) => late.seq),
    [child.seq],
  );
  assert.equal(row.followUp.parent.queryGeneration, parent.queryGeneration);
  assert.equal(row.followUp.child, null);
});
