/**
 * CP-4 H5 診断（DR-CP4-S1C2-27）：製品の `useNir1RelatedScenes` を harness の
 * page に mount し、製品の renderer の経路（hook の debounce、seed の読取、
 * `fetchRelatedPastScenes`、`graph-ready` の後の再 query）のままの時刻を取る。
 *
 * 店（tree／project／phase／workspace）は `cp4-harness.ts` の `openWorkspace`
 * が製品の API で整え、ここでは workspace の store に開いた path と revision を
 * 写すだけ。1 sample は新しい React root の mount から始まり、子の結果が
 * Graph つきで commit される（または上限）まで待って unmount する。
 *
 * 時計はすべて renderer の `performance.now()`。commit の時刻は probe の
 * `useLayoutEffect`（React の commit の中）で取る。wrapper の層の呼出しと応答は
 * `nir1RelatedScenesApi.timing.ts`、transport の層は `shell.timing.ts` が記録する。
 */
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { useNir1RelatedScenes } from "@/features/related-scenes/useNir1RelatedScenes";
import {
  listenRelatedScenesGraphReady,
  listenRelatedScenesIndexReady,
} from "@/features/related-scenes/nir1RelatedScenesApi";
import { useWorkspaceStore } from "@/features/workspace/store";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import type { Nir1RelatedScenesFetchResult } from "@/features/related-scenes/nir1RelatedScenesFetchTypes";

interface Commit {
  at: number;
  fetch: boolean;
  loading: boolean;
  sceneId: string | null;
  result: ReturnType<typeof describeFetch> | null;
}

const host = globalThis as unknown as {
  __cp4IpcTiming?: Record<string, unknown>[];
  __cp4BridgeTiming?: Record<string, unknown>[];
  __cp4BridgeTimingInstalled?: boolean;
};
const apiRows = (host.__cp4IpcTiming ??= []);
const bridgeRows = (host.__cp4BridgeTiming ??= []);

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

function describeFetch(value: Nir1RelatedScenesFetchResult) {
  const ir = value.result.kind === "raw" ? value.result.ir : null;
  return {
    status: value.status,
    rawStatus: value.rawStatus,
    resultKind: value.result.kind,
    irStatus: ir?.status ?? (value.result.kind === "raw" ? null : "available"),
    irReason: ir && ir.status === "unavailable" ? ir.reason : null,
    completion: value.completion
      ? {
          outcome: value.completion.outcome,
          deadlineExceeded: value.completion.deadlineExceeded,
        }
      : null,
    graphOutcome: value.graphOutcome ?? null,
    graph: value.graph
      ? {
          pathAttachments: value.graph.pathAttachments.length,
          graphOnly: value.graph.graphOnly !== null,
        }
      : null,
    sceneCount: value.result.scenes.length,
    timing: {
      tFetchMs: value.timing.tFetchMs,
      tRawReadyMs: value.timing.tRawReadyMs,
      tReturnMs: value.timing.tReturnMs,
      native: value.timing.native ?? null,
    },
  };
}

function Probe({ log }: { log: Commit[] }) {
  const { sceneId, fetch, loading } = useNir1RelatedScenes(true);
  useLayoutEffect(() => {
    log.push({
      at: performance.now(),
      fetch: fetch !== null,
      loading,
      sceneId,
      result: fetch ? describeFetch(fetch) : null,
    });
  }, [fetch, loading, sceneId, log]);
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** workspace の store を、harness が開いた workspace に揃える（hook の deps）。 */
function prepare(input: { workspacePath: string }) {
  const identity = getCurrentWorkspaceIdentity();
  useWorkspaceStore.setState({
    activeWorkspacePath: input.workspacePath,
    workspaceOpenRevision: identity?.openRevision ?? 1,
  });
  return {
    identity,
    bridgeTimingInstalled: host.__cp4BridgeTimingInstalled === true,
  };
}

/**
 * 1 sample：mount → 子の Graph つきの commit（`graphOutcome === "graph-ready"`）
 * を見たら `holdMs` 待って unmount。来なければ、最後の commit から
 * `settleMs` 何も起きないか、`limitMs` で止める。
 */
async function sample(input: {
  projectId: string;
  limitMs: number;
  settleMs: number;
  holdMs: number;
}) {
  await listen();
  apiRows.length = 0;
  bridgeRows.length = 0;
  const noticeFrom = notices.length;
  const log: Commit[] = [];
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const mountedAt = performance.now();
  root.render(<Probe log={log} />);
  let stop: "graph-ready" | "settled" | "limit" = "limit";
  while (performance.now() - mountedAt < input.limitMs) {
    await sleep(5);
    const last = log.at(-1);
    if (log.some((row) => row.result?.graphOutcome === "graph-ready")) {
      stop = "graph-ready";
      break;
    }
    const published = log.filter((row) => row.result !== null).length;
    if (
      last &&
      published >= 2 &&
      !last.loading &&
      performance.now() - last.at >= input.settleMs
    ) {
      stop = "settled";
      break;
    }
  }
  await sleep(input.holdMs);
  const unmountedAt = performance.now();
  root.unmount();
  element.remove();
  // unmount の release が transport に届くのを短く待つ。
  await sleep(50);
  return {
    stop,
    mountedAt,
    unmountedAt,
    commits: log,
    notices: notices
      .slice(noticeFrom)
      .filter((row) => row.projectId === input.projectId)
      .map(({ kind, at }) => ({ kind, at })),
    api: apiRows.map((row) => ({ ...row })),
    bridge: bridgeRows.map((row) => ({ ...row })),
  };
}

export const hookProbe = { prepare, sample };
