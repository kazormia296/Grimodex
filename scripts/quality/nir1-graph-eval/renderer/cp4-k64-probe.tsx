/**
 * CP-4 S1f：K6/4 の R5 の hook の消費者（DR-CP4-F-5）。製品の
 * `useNir1RelatedScenes` を harness の page に mount し、hook が出した親と子の
 * query を、製品の renderer の経路（hook の debounce、pin からの seed の読取、
 * `fetchRelatedPastScenes`、`graph-ready` の後の取り直し）のまま観測する。seed は
 * harness が渡さない（製品の規則で hook が読む）。低い層の API で continue を
 * 直接待つことはしない。
 *
 * 1 sample（R4）: 新しい React root の mount から、次のうち最も早いもので終わる。
 *   - 子（親の次の fetch）が completed で返り、その結果が React の commit に出た
 *     （child-published）、または completed 以外で返った（child-ended）
 *   - 親の `t_raw_ready` + T_show が経った（t-show-elapsed）
 *   - 親が completed 以外で返った（parent-ended。Related Scenes の session の停止）
 *   - 親が返らないまま harness の上限が経った（harness-limit。K6/4 の値ではない。
 *     Node の側は run を止める）
 * レビュー P2-3: 子が返って終わった sample は、すぐには unmount せず、混入の判定
 * （N1、N29、N32: 子の世代の二度目の公開、W_f の後の Graph の混入）のためだけに
 * 観測の窓を置く。窓は、子の世代までに呼ばれた Graph の continue がすべて返り、
 * かつ子の `t_raw_ready` + W_f（製品の子の窓が長ければその値）が過ぎるまでで、その後
 * React の commit の余裕（`MIX_COMMIT_MARGIN_MS`）を置く。harness の上限
 * （`mixGuardMs`。K6/4 の値ではない）で切れたら `harness-limit` と記録し、Node の側は
 * その sample を X10 にする。sample の終わり（`endedAt`、R4。q3 と latency）は窓で
 * 変えない。その後に unmount する。release と owner の静止の待ち（R4 の後半）は
 * Node の側が owner の状態で行う。sample の間に編集、場面の切替え、別の query、
 * D-final は起こさない（この page は何も書かない）。
 *
 * 時計はすべて renderer の `performance.now()`（R6）。commit の時刻は probe の
 * `useLayoutEffect`（React の commit の中）。fetch の呼出しと答えは
 * `fetchRelatedScenes.timing.ts`、wrapper の層の呼出しと答えは
 * `nir1RelatedScenesApi.timing.ts` が記録する。結果の要約は sample の後に作る。
 */
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { useNir1RelatedScenes } from "@/features/related-scenes/useNir1RelatedScenes";
import {
  listenRelatedScenesGraphReady,
  listenRelatedScenesIndexReady,
} from "@/features/related-scenes/nir1RelatedScenesApi";
import { fuseNir1RelatedScenesGraph } from "@/features/related-scenes/nir1GraphFusion";
import type { Nir1RelatedScenesFetchResult } from "@/features/related-scenes/nir1RelatedScenesFetchTypes";
import type { FetchTimingRow } from "./fetchRelatedScenes.timing";

interface ApiRow {
  cmd: string;
  calledAt: number;
  resolvedAt: number | null;
  ok: boolean | null;
  settle: string | null;
  status: string | null;
  reason: string | null;
}

interface Commit {
  at: number;
  fetchSeq: number | null;
  loading: boolean;
  display: string | null;
}

const host = globalThis as unknown as {
  __cp4IpcTiming?: ApiRow[];
  __cp4FetchTiming?: FetchTimingRow[];
  __cp4FetchSeq?: WeakMap<object, number>;
  __cp4FetchTimingInstalled?: boolean;
};
const apiRows = (host.__cp4IpcTiming ??= []);
const fetchRows = (host.__cp4FetchTiming ??= []);
const seqOf = (host.__cp4FetchSeq ??= new WeakMap<object, number>());

const notices: {
  kind: "graph-ready" | "index-ready";
  projectId: string;
  at: number;
}[] = [];
let listening: Promise<unknown> | null = null;

function listen() {
  listening ??= Promise.all([
    listenRelatedScenesGraphReady((projectId) =>
      notices.push({ kind: "graph-ready", projectId, at: performance.now() }),
    ),
    listenRelatedScenesIndexReady((projectId) =>
      notices.push({ kind: "index-ready", projectId, at: performance.now() }),
    ),
  ]);
  return listening;
}

/** The shown content (N32: a generation that showed two contents). */
function displayKey(value: Nir1RelatedScenesFetchResult): string {
  const graph = value.graph ?? null;
  return JSON.stringify([
    value.graphOutcome ?? null,
    value.result.scenes.map((row) => row.sceneId),
    graph
      ? [
          graph.graphOnly?.sceneId ?? null,
          graph.pathAttachments.map((row) => [row.sceneId, row.edges.length]),
        ]
      : null,
  ]);
}

function Probe({ log }: { log: Commit[] }) {
  const { fetch, loading } = useNir1RelatedScenes(true);
  useLayoutEffect(() => {
    const at = performance.now();
    log.push({
      at,
      fetchSeq: fetch ? (seqOf.get(fetch) ?? -1) : null,
      loading,
      display: fetch ? displayKey(fetch) : null,
    });
  }, [fetch, loading, log]);
  return null;
}

function edgeCountOf(
  graph: NonNullable<Nir1RelatedScenesFetchResult["graph"]>,
) {
  return (
    graph.pathAttachments.reduce((sum, row) => sum + row.edges.length, 0) +
    (graph.graphOnly ? graph.graphOnly.path.edges.length : 0)
  );
}

/** The record of one returned fetch (k64-record.mjs reads it). */
function summarize(value: Nir1RelatedScenesFetchResult, sceneId: string) {
  const ir = value.result.kind === "raw" ? value.result.ir : null;
  const graph = value.graph ?? null;
  const fused = value.graphOutcome
    ? fuseNir1RelatedScenesGraph({
        result: value.result,
        queryBinding: value.queryBinding,
        querySceneId: sceneId,
        graphOutcome: value.graphOutcome,
        ...(graph ? { graph } : {}),
      })
    : null;
  return {
    status: value.status,
    rawStatus: value.rawStatus,
    resultKind: value.result.kind,
    irStatus: ir ? ir.status : "available",
    irReason: ir && ir.status === "unavailable" ? ir.reason : null,
    completion: value.completion
      ? {
          outcome: value.completion.outcome,
          deadlineExceeded: value.completion.deadlineExceeded,
        }
      : null,
    graphOutcome: value.graphOutcome ?? null,
    graph: graph
      ? {
          edgeCount: edgeCountOf(graph),
          graphOnlySceneId: graph.graphOnly?.sceneId ?? null,
          pathAttachmentSceneIds: graph.pathAttachments.map(
            (row) => row.sceneId,
          ),
        }
      : null,
    initialSnapshot: value.initialSnapshot
      ? {
          indexUsable: value.initialSnapshot.indexUsable,
          querySupported: value.initialSnapshot.querySupported,
        }
      : null,
    rawSceneIds: value.rawScenes.map((row) => row.sceneId),
    irSceneIds:
      value.result.kind === "fused"
        ? value.result.scenes
            .filter((row) => row.kind !== "raw")
            .map((row) => row.sceneId)
        : [],
    finalSceneIds: fused
      ? fused.rows.map((row) => row.sceneId)
      : value.result.scenes.map((row) => row.sceneId),
    timing: {
      tFetchMs: value.timing.tFetchMs,
      tRawReadyMs: value.timing.tRawReadyMs,
      tReturnMs: value.timing.tReturnMs,
      refreshTrigger: value.timing.refreshTrigger ?? null,
      graphWindowMs: value.timing.graphWindowMs ?? null,
      native: value.timing.native ?? null,
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Graph continue's wrapper command (run-sample.mjs `GRAPH_CONTINUE`). */
const GRAPH_CONTINUE = "related_scenes_graph_continue";
/**
 * P2-3: after the window's conditions hold, the time a state update the last
 * answer caused needs to reach a React commit (a harness margin, not a K6/4
 * value).
 */
const MIX_COMMIT_MARGIN_MS = 16;

type MixWindowReason = "settled" | "harness-limit" | "not-applied";

/**
 * P2-3: keeps the root mounted after the sample's end until every Graph
 * continue issued up to the child's generation returned and the child's
 * `t_raw_ready` + W_f passed (the mixing checks only).
 */
async function observeMixWindow(input: {
  child: FetchTimingRow;
  wfMs: number;
  mixGuardMs: number;
  endedAt: number;
}): Promise<{ reason: MixWindowReason; until: number }> {
  const { child } = input;
  const rawReady = child.value?.timing.tRawReadyMs ?? null;
  const windowMs = Math.max(input.wfMs, child.value?.timing.graphWindowMs ?? 0);
  for (;;) {
    const now = performance.now();
    const next = fetchRows.find((row) => row.seq > child.seq);
    const continuesReturned = apiRows
      .filter(
        (row) =>
          row.cmd === GRAPH_CONTINUE &&
          (next === undefined || row.calledAt < next.calledAt),
      )
      .every((row) => row.resolvedAt !== null);
    const wfPassed = rawReady === null || now >= rawReady + windowMs;
    if (continuesReturned && wfPassed) {
      await sleep(MIX_COMMIT_MARGIN_MS);
      return { reason: "settled", until: performance.now() };
    }
    if (now - input.endedAt >= input.mixGuardMs)
      return { reason: "harness-limit", until: now };
    await sleep(2);
  }
}

type EndReason =
  | "child-published"
  | "child-ended"
  | "t-show-elapsed"
  | "parent-ended"
  | "harness-limit";

/** One R+IR+Graph sample of the steady state (R4). */
async function sample(input: {
  projectId: string;
  tShowMs: number;
  parentLimitMs: number;
  /** K6/4 W_f (constants.mjs), the window's lower end after t_raw_ready_c. */
  wfMs: number;
  /** The harness guard of the observation window (not a K6/4 value). */
  mixGuardMs: number;
}) {
  await listen();
  apiRows.length = 0;
  fetchRows.length = 0;
  const noticeFrom = notices.length;
  const log: Commit[] = [];
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const mountedAt = performance.now();
  root.render(<Probe log={log} />);
  let endReason: EndReason = "harness-limit";
  for (;;) {
    await sleep(2);
    const now = performance.now();
    const [parent, child] = fetchRows;
    if (!parent || parent.resolvedAt === null) {
      if (now - mountedAt >= input.parentLimitMs) break;
      continue;
    }
    if (parent.value?.status !== "completed") {
      endReason = "parent-ended";
      break;
    }
    if (child && child.resolvedAt !== null) {
      if (child.value?.status !== "completed") {
        endReason = "child-ended";
        break;
      }
      if (log.some((commit) => commit.fetchSeq === child.seq)) {
        endReason = "child-published";
        break;
      }
    }
    const rawReady = parent.value.timing.tRawReadyMs;
    if (rawReady !== null && now >= rawReady + input.tShowMs) {
      endReason = "t-show-elapsed";
      break;
    }
  }
  const endedAt = performance.now();
  const returnedChild = fetchRows[1];
  const mixWindow =
    (endReason === "child-published" || endReason === "child-ended") &&
    returnedChild !== undefined
      ? await observeMixWindow({
          child: returnedChild,
          wfMs: input.wfMs,
          mixGuardMs: input.mixGuardMs,
          endedAt,
        })
      : { reason: "not-applied" as const, until: endedAt };
  root.unmount();
  element.remove();
  const unmountedAt = performance.now();
  return {
    endReason,
    mountedAt,
    endedAt,
    mixWindow,
    unmountedAt,
    fetches: fetchRows.map((row) => ({
      seq: row.seq,
      sceneId: row.sceneId,
      queryGeneration: row.queryGeneration,
      refreshTrigger: row.refreshTrigger,
      seed: row.seed,
      rawOnly: row.rawOnly,
      calledAt: row.calledAt,
      resolvedAt: row.resolvedAt,
      failed: row.failed,
      result: row.value ? summarize(row.value, row.sceneId) : null,
    })),
    commits: log,
    notices: notices
      .slice(noticeFrom)
      .filter((row) => row.projectId === input.projectId)
      .map(({ kind, at }) => ({ kind, at })),
    api: apiRows.map((row) => ({
      cmd: row.cmd,
      calledAt: row.calledAt,
      resolvedAt: row.resolvedAt,
      ok: row.ok,
      settle: row.settle,
      status: row.status,
      reason: row.reason,
    })),
  };
}

/** Whether the build put both timing shims in front of the product modules. */
function instrumented() {
  return { fetchTiming: host.__cp4FetchTimingInstalled === true };
}

export const k64Probe = { sample, instrumented };
