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
  appendCounterRun,
  boundaryCounters,
  devTracePlan,
  mergeNativeRecords,
  mixWindowAfter,
  summarizeTraceRun,
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

test("TR-3: Native の記録は seq で併合し（後の読取の ticket の状態を採る）、dropped を残す", () => {
  const first = k64NativeRecord({
    seq: 1,
    ticket: { ...k64NativeRecord().ticket, settled: false, outcome: null },
  });
  const later = k64NativeRecord({ seq: 1 });
  const merged = mergeNativeRecords([
    { dropped: 0, records: [first] },
    { dropped: 2, records: [later, k64NativeRecord({ seq: 3 })] },
  ]);
  assert.deepEqual(
    merged.records.map((row) => row.seq),
    [1, 3],
  );
  assert.equal(merged.records[0].ticket.settled, true);
  assert.equal(merged.dropped, 2);
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
  const dropped = alignSeededBegins({
    observation,
    native: { ...merged, dropped: 1 },
  });
  assert.equal(dropped.aligned, false);
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
