/**
 * CP-4 S1c-2 harness page (setup driver and runner). Built only by the
 * harness renderer build (with the product `index.html`, so the availability
 * alias is checked on the full product graph) and served by the loopback
 * static server.
 *
 * The page writes only through the product's renderer API (`invoke` of the
 * product's IPC wrapper, `createProject`, `createCodexEntry`,
 * `createCodexRelation`, `upsertScenePin`, the body declaration wrappers) and
 * measures only through `fetchRelatedPastScenes(…, { mode: "hybrid" })`,
 * the product's begin/continue path. No SQL is written here. It is used with
 * the synthetic dev fixture only; no G-case fixture is read.
 *
 * Clock: every time here is the renderer `performance.now()` (the clock the
 * product's join helper compares). The call and answer times of the begin
 * and the Graph wait come from the harness timing shim of the product's
 * related-scenes API module (`nir1RelatedScenesApi.timing.ts`, resolved in
 * place of the product module by the harness build only).
 */
import { invoke } from "@/lib/tauri";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { setCurrentRuntimeProjectId } from "@/runtime/projectIdentity";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { createProject, listProjects } from "@/features/project/api";
import { useProjectStore } from "@/features/project/projectStore";
import { loadSceneContent, saveSceneContent } from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";
import { createCodexEntry } from "@/features/codex/api";
import { createCodexRelation } from "@/features/codex/codexRelationApi";
import { upsertScenePin } from "@/features/codex/sceneCodexPinsApi";
import { prosemirrorToText } from "@/lib/prosemirror";
import { useDebugLogStore } from "@/lib/debugLog";
import {
  semanticIndexStatus,
  semanticReindexAll,
  semanticSearch,
} from "@/features/semantic-search/api";
import { fetchRelatedPastScenes } from "@/features/related-scenes/fetchRelatedScenes";
import {
  beginRelatedScenes,
  continueRelatedScenesGraph,
  listenRelatedScenesGraphReady,
  listenRelatedScenesIndexReady,
  qualifyNir1Evidence,
  releaseRelatedScenes,
  settleRelatedScenesGraph,
} from "@/features/related-scenes/nir1RelatedScenesApi";
import {
  buildSemanticRecallQuery,
  fetchSparseSceneIds,
  recallParamsForLang,
  SEMANTIC_RECALL_RESCUE_MARGIN,
} from "@/features/chat/semanticRecall";
import { computeSceneTimeIndex } from "@/features/codex/phaseResolver";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import { selectRelatedPastScenesWithAnchor } from "@/features/related-scenes/selectRelatedScenes";
import {
  RELATED_SCENES_MAX,
  RELATED_SCENES_RELATIVE_GAP,
} from "@/features/related-scenes/relatedScenesConfig";
import { buildSparseQuery } from "@/features/related-scenes/seedTerms";
import { fuseNir1RelatedScenesGraph } from "@/features/related-scenes/nir1GraphFusion";
import {
  declareBody,
  readBodyDeclarationState,
} from "@/features/editor/sceneMeta/bodyDeclaration/bodyDeclarationApi";
import { BODY_DECLARATION_AXES } from "@/features/editor/sceneMeta/bodyDeclaration/bodyDeclarationTypes";

interface IpcRow {
  cmd: string;
  calledAt: number;
  resolvedAt: number | null;
  ok: boolean | null;
  settle: string | null;
  status: string | null;
  reason: string | null;
  graphStatus: string | null;
  graphReason: string | null;
  pathAttachments: number | null;
  graphOnly: boolean | null;
}

/** The rows the timing shim writes (created here if the shim has not run). */
const timingHost = globalThis as unknown as { __cp4IpcTiming?: IpcRow[] };
const ipcRows: IpcRow[] = (timingHost.__cp4IpcTiming ??= []);
let openRevision = 0;

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 600) : String(error);
}

/** Whether the build put the timing shim in front of the product module. */
function instrument() {
  return {
    wrapped: timingHost.__cp4IpcTiming === ipcRows,
    method: "harness-build-timing-shim",
  };
}

async function call(cmd: string, args: Record<string, unknown> = {}) {
  try {
    return { ok: true, value: await invoke<unknown>(cmd, args) };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

async function openWorkspace(input: {
  workspacePath: string;
  projectId: string | null;
  activeSceneId?: string | null;
}) {
  await invoke("open_workspace", { path: input.workspacePath });
  setCurrentWorkspaceIdentity({
    path: input.workspacePath,
    openRevision: ++openRevision,
  });
  if (input.projectId) await selectProject(input);
  return { openRevision };
}

async function selectProject(input: {
  projectId: string | null;
  activeSceneId?: string | null;
}) {
  const projectId = input.projectId!;
  publishCurrentProjectId(projectId);
  setCurrentRuntimeProjectId(projectId);
  useProjectStore.setState({
    currentProjectId: projectId,
    projects: await listProjects(),
  });
  await useTreeStore.getState().reloadTreeOrThrow(projectId, openRevision);
  if (input.activeSceneId)
    useTreeStore.setState({ activeSceneId: input.activeSceneId });
  usePhaseStore.setState({ resolutionMode: "reading" });
  return { nodeCount: useTreeStore.getState().nodes.length };
}

async function guarded<T>(work: () => Promise<T>) {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

const human = () => createCanonicalWriteContext("human");

const api = {
  createProject: (input: { id: string; title: string; language: string }) =>
    guarded(async () => {
      await createProject(input);
      return input.id;
    }),
  createCodexEntry: (input: {
    id: string;
    projectId: string;
    type: string;
    name: string;
    summary: string;
  }) =>
    guarded(async () => {
      const result = await createCodexEntry(input, { writeContext: human() });
      return { id: String(result.id) };
    }),
  createCodexRelation: (input: {
    id: string;
    projectId: string;
    fromCodexId: string;
    toCodexId: string;
    relationType: string;
    label: string;
    directionality: "directed" | "symmetric";
  }) =>
    guarded(async () => {
      const row = await createCodexRelation(
        {
          id: input.id,
          projectId: input.projectId,
          fromCodexId: input.fromCodexId,
          toCodexId: input.toCodexId,
          relationType: input.relationType,
          label: input.label,
          depthHint: null,
          sourceMapEdgeId: null,
          directionality: input.directionality,
        },
        { writeContext: human() },
      );
      return { id: String(row?.id ?? input.id) };
    }),
  upsertScenePin: (input: { sceneId: string; entryId: string }) =>
    guarded(async () => {
      await upsertScenePin(input.sceneId, input.entryId);
      return true;
    }),
  sceneText: (sceneId: string) =>
    guarded(async () => prosemirrorToText(await loadSceneContent(sceneId))),
  humanWriteContext: () => human(),
};

/** K2/4 declaration through the product wrappers (Main's CI seam approves). */
const declaration = {
  state: (scene: {
    workspacePath: string;
    projectId: string;
    sceneId: string;
  }) => readBodyDeclarationState(scene),
  declare: async (scene: {
    workspacePath: string;
    projectId: string;
    sceneId: string;
  }) => {
    const read = await readBodyDeclarationState(scene);
    if (!read.ok || !read.snapshot.occ)
      return { ok: false, stage: "state", read };
    const confirmed = Object.fromEntries(
      BODY_DECLARATION_AXES.map((axis) => [axis, true]),
    ) as Parameters<typeof declareBody>[0]["confirmed"];
    const result = await declareBody({
      scene,
      occ: read.snapshot.occ,
      declarationToken: read.snapshot.declarationToken,
      confirmed,
    });
    return { ok: result.ok, stage: "declare", result, before: read };
  },
};

function edgeCountOf(graph: {
  pathAttachments: readonly { edges: readonly unknown[] }[];
  graphOnly: { path: { edges: readonly unknown[] } } | null;
}): number {
  return (
    graph.pathAttachments.reduce((sum, row) => sum + row.edges.length, 0) +
    (graph.graphOnly ? graph.graphOnly.path.edges.length : 0)
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Related Scenes query through the product path. `seed` null is the R+IR
 * arm; a seed is the R+IR+Graph arm. The session is released after the
 * tracked IPC calls settled (bounded), so the next sample starts clean.
 */
async function measure(input: { sceneId: string; seed: string | null }) {
  instrument();
  ipcRows.length = 0;
  useDebugLogStore.getState().clear();
  const result = await fetchRelatedPastScenes(
    input.sceneId,
    input.seed
      ? { mode: "hybrid", graphSeedEntityId: input.seed }
      : { mode: "hybrid" },
  );
  const settleBy = performance.now() + 3_000;
  while (
    ipcRows.some((row) => row.resolvedAt === null) &&
    performance.now() < settleBy
  )
    await sleep(2);
  const graph = result.graph ?? null;
  const fused =
    input.seed && result.graphOutcome
      ? fuseNir1RelatedScenesGraph({
          result: result.result,
          queryBinding: result.queryBinding,
          querySceneId: input.sceneId,
          graphOutcome: result.graphOutcome,
          ...(graph ? { graph } : {}),
        })
      : null;
  const failures = useDebugLogStore
    .getState()
    .entries.filter(
      (entry) =>
        entry.tag === "RelatedScenes" &&
        (entry.level === "warn" || entry.level === "error"),
    )
    .map(({ tag, message }) => ({ tag, message }));
  const summary = {
    status: result.status,
    rawStatus: result.rawStatus,
    timing: {
      tFetchMs: result.timing.tFetchMs,
      tRawReadyMs: result.timing.tRawReadyMs,
      tReturnMs: result.timing.tReturnMs,
      native: result.timing.native ?? null,
    },
    initialSnapshot: result.initialSnapshot,
    completion: result.completion
      ? {
          outcome: result.completion.outcome,
          deadlineExceeded: result.completion.deadlineExceeded,
        }
      : null,
    resultKind: result.result.kind,
    graphOutcome: result.graphOutcome ?? null,
    graph: graph
      ? {
          pathAttachments: graph.pathAttachments.map((row) => ({
            sceneId: row.sceneId,
            hop: row.hop,
            edges: row.edges.length,
          })),
          graphOnlySceneId: graph.graphOnly?.sceneId ?? null,
          edgeCount: edgeCountOf(graph),
        }
      : null,
    rawSceneIds: result.rawScenes.map((row) => row.sceneId),
    resultSceneIds: result.result.scenes.map((row) => row.sceneId),
    finalSceneIds: fused
      ? fused.rows.map((row) => row.sceneId)
      : result.result.scenes.map((row) => row.sceneId),
    fusionDropped: fused?.dropped ?? null,
    ipc: ipcRows.map((row) => ({ ...row })),
    failures,
  };
  result.session?.release();
  return summary;
}

/**
 * Rebuilds the Raw (semantic) source index of the opened workspace, as the P
 * harness's `buildRaw`: the copied DB keeps no reusable vectors, and the
 * Graph worker's registration needs a complete source index.
 */
async function buildRaw(input: {
  projectId: string;
  label: string;
  sceneIds: string[];
  queryBody: string;
}) {
  const started = performance.now();
  await semanticSearch({
    projectId: input.projectId,
    query: input.queryBody,
    limit: 30,
  });
  const before = await semanticIndexStatus(input.projectId);
  const built = performance.now();
  const indexed = await semanticReindexAll(input.projectId, input.label);
  const status = await semanticIndexStatus(input.projectId);
  const unsearchable: string[] = [];
  for (const sceneId of input.sceneIds) {
    const body = prosemirrorToText(await loadSceneContent(sceneId)).trim();
    const probe = await semanticSearch({
      projectId: input.projectId,
      query: body,
      limit: 30,
    });
    if (!probe.some((hit) => hit.sceneId === sceneId))
      unsearchable.push(sceneId);
  }
  return {
    ok:
      status.staleChunkCount === 0 &&
      status.indexedSceneCount === input.sceneIds.length &&
      unsearchable.length === 0,
    before,
    status,
    indexed,
    unsearchable,
    modelWarmupMs: built - started,
    buildMs: performance.now() - built,
  };
}

/**
 * Builds the measurement process's Chronicle Index through the actual query
 * route (as the P harness's `buildIr`): queries until the first snapshot is
 * usable and the IR is ready. The Index proof lives in the process, so each
 * measurement Main builds it once.
 */
async function buildIndex(input: { sceneId: string; limitMs: number }) {
  const started = performance.now();
  const probes = [];
  while (performance.now() - started < input.limitMs) {
    const sample = await measure({ sceneId: input.sceneId, seed: null });
    probes.push({
      status: sample.status,
      initialSnapshot: sample.initialSnapshot,
      completion: sample.completion,
    });
    if (
      sample.initialSnapshot?.indexUsable &&
      sample.completion?.outcome === "ir-ready"
    )
      return { ok: true, durationMs: performance.now() - started, probes };
    await sleep(50);
  }
  return { ok: false, durationMs: performance.now() - started, probes };
}

// ---- CQ-DEFER（D′）の実機の確認 (ii)（cq-deferred-decisions §6.8 の 3〜9） ----
//
// 製品の renderer API（timing shim の後ろの製品の関数）を 1 段ずつ呼ぶ。測定の
// receipt は書かない（DR-CP4-S1C2-24）。

const graphReadyEvents: { projectId: string; at: number }[] = [];
let graphReadyListening: Promise<unknown> | null = null;

function listenGraphReady() {
  graphReadyListening ??= listenRelatedScenesGraphReady((projectId) =>
    graphReadyEvents.push({ projectId, at: performance.now() }),
  );
  return graphReadyListening;
}

/** 製品の begin と同じ query（`fetchNir1RelatedPastScenes` の組み立て）。 */
async function savedQuery(sceneId: string) {
  const body = prosemirrorToText((await loadSceneContent(sceneId)) ?? "");
  return {
    body,
    query: buildSemanticRecallQuery({ userMessage: "", sceneBody: body }),
  };
}

/**
 * 製品が Graph の continue に渡す Raw R（`fetchNir1RelatedPastScenes` と同じ
 * 選択：現在の Scene と読書順で後の Scene を除き、閾値と救済、sparse を使う）。
 */
async function productRawR(
  sceneId: string,
  projectId: string,
  saved: { body: string; query: string },
  denseHits: readonly { sceneId: string }[],
) {
  const params = recallParamsForLang(getCurrentProjectLanguage());
  const sparseSceneIds = await fetchSparseSceneIds({
    projectId,
    query: buildSparseQuery(saved.query, saved.body),
  }).catch(() => [] as string[]);
  const raw = selectRelatedPastScenesWithAnchor(
    denseHits.map((hit) => ({ ...hit })) as Parameters<
      typeof selectRelatedPastScenesWithAnchor
    >[0],
    {
      currentSceneId: sceneId,
      sceneOrder: computeSceneTimeIndex(
        useTreeStore.getState().nodes,
        usePhaseStore.getState().resolutionMode,
      ),
      minScore: params.gateScore,
      maxScenes: RELATED_SCENES_MAX,
      rescueMargin: SEMANTIC_RECALL_RESCUE_MARGIN,
      relativeRescue: { gap: RELATED_SCENES_RELATIVE_GAP },
      sparseSceneIds,
    },
  );
  return raw.scenes.map((scene) => scene.sceneId);
}

interface HeldInput {
  workspacePath: string;
  projectId: string;
  sceneId: string;
  seed: string | null;
  readyWaitMs: number;
}

async function timedBegin(input: HeldInput, query: string) {
  const calledAt = performance.now();
  const response = await beginRelatedScenes({
    expectedWorkspacePath: input.workspacePath,
    projectId: input.projectId,
    currentSceneId: input.sceneId,
    query,
    ...(input.seed ? { graphSeedEntityId: input.seed } : {}),
  });
  const resolvedAt = performance.now();
  return {
    response,
    ticket:
      response.ir.status === "pending" ? response.ir.operationTicket : null,
    row: {
      roundTripMs: resolvedAt - calledAt,
      calledAt,
      ir: response.ir.status === "pending" ? "pending" : response.ir.reason,
      graph: response.graph ?? null,
      denseHits: response.denseHits.length,
      snapshotUsable: response.snapshot.originalSnapshotUsable,
      supportedProfile: response.snapshot.supportedProfile,
      firstSnapshotElapsedMs: response.timing?.firstSnapshotElapsedMs ?? null,
      rawReadyElapsedMs: response.timing?.rawReadyElapsedMs ?? null,
    },
  };
}

/**
 * §6.8 の 3：seed つきの begin → Graph の continue（Native の await、上限 2 s）→
 * Graph-only の handle があれば click（`nir1_evidence_qualify`）→ `unused` の
 * settle → `graph-ready` → 同じ query の再 begin（Native の記録で `cached` を
 * 確かめる）→ continue → `used` の settle → release。seed が null なら begin と
 * release だけ（§6.8 の 5 の比較）。
 */
async function heldSample(input: HeldInput) {
  await listenGraphReady();
  const saved = await savedQuery(input.sceneId);
  const query = saved.query;
  const eventsBefore = graphReadyEvents.length;
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  const first = await timedBegin(input, query);
  out.begin = first.row;
  const rawIds = await productRawR(
    input.sceneId,
    input.projectId,
    saved,
    first.response.denseHits,
  );
  out.rawR = rawIds.length;
  try {
    if (first.ticket && first.response.graph?.status === "pending") {
      const waitAt = performance.now();
      const wait = await continueRelatedScenesGraph(first.ticket, rawIds);
      out.graph = {
        status: wait.status,
        reason: wait.status === "unavailable" ? wait.reason : null,
        waitMs: performance.now() - waitAt,
        sinceBeginCallMs: performance.now() - first.row.calledAt,
        pathAttachments:
          wait.status === "available" ? wait.pathAttachments.length : null,
        graphOnly: wait.status === "available" ? wait.graphOnly !== null : null,
      };
      if (wait.status === "available" && wait.graphOnly) {
        const clickAt = performance.now();
        const click = await qualifyNir1Evidence(
          wait.graphOnly.navigationIdentity,
        );
        out.click = {
          status: click.status,
          reason: click.status === "unavailable" ? click.reason : null,
          ms: performance.now() - clickAt,
        };
      }
      const settleAt = performance.now();
      const settled = await settleRelatedScenesGraph(first.ticket, "unused");
      out.settle = { status: settled.status };
      const deadline = settleAt + input.readyWaitMs;
      while (
        !graphReadyEvents
          .slice(eventsBefore)
          .some((event) => event.projectId === input.projectId) &&
        performance.now() < deadline
      )
        await sleep(5);
      const ready = graphReadyEvents
        .slice(eventsBefore)
        .filter((event) => event.projectId === input.projectId);
      out.graphReady = {
        count: ready.length,
        afterSettleMs: ready[0] ? ready[0].at - settleAt : null,
      };
      if (ready.length > 0) {
        const again = await timedBegin(input, query);
        const requery: Record<string, unknown> = { begin: again.row };
        if (again.ticket && again.response.graph?.status === "pending") {
          const wait = await continueRelatedScenesGraph(
            again.ticket,
            await productRawR(
              input.sceneId,
              input.projectId,
              saved,
              again.response.denseHits,
            ),
          );
          requery.graph = {
            status: wait.status,
            reason: wait.status === "unavailable" ? wait.reason : null,
          };
          await settleRelatedScenesGraph(again.ticket, "used");
        }
        if (again.ticket) await releaseRelatedScenes(again.ticket);
        out.requery = requery;
      }
    }
  } catch (error) {
    errors.push(describe(error));
  } finally {
    if (first.ticket) await releaseRelatedScenes(first.ticket).catch(() => {});
  }
  out.errors = errors;
  return out;
}

const indexReadyEvents: { projectId: string; at: number }[] = [];
let indexReadyListening: Promise<unknown> | null = null;

function listenIndexReady() {
  indexReadyListening ??= listenRelatedScenesIndexReady((projectId) =>
    indexReadyEvents.push({ projectId, at: performance.now() }),
  );
  return indexReadyListening;
}

/**
 * §6.8 の 9：同じ project を待つ 2 つの表示と、別の Scene の連続の自動保存。
 * 表示は製品の `useNir1RelatedScenes` の再取得の契機に倣い、`index-ready`
 * （この project）と `graph-ready`（この project。前の取得の後に届いたもの）の
 * たびに製品の fetch をやり直す消費者を同じ renderer に置く。最初の取得が
 * 終わってから `durationMs` の間 `editEveryMs` ごとに保存し、その後
 * `quietMs` の間は保存を止めて観測する。
 */
async function twoViews(input: {
  projectId: string;
  viewSceneId: string;
  seed: string;
  editSceneId: string;
  durationMs: number;
  editEveryMs: number;
  quietMs: number;
  views: number;
}) {
  await listenGraphReady();
  await listenIndexReady();
  const startedAt = performance.now();
  const fetches: {
    view: number;
    at: number;
    trigger: string;
    graphOutcome: unknown;
    status: string;
  }[] = [];
  const saves: { at: number; ok: boolean; error?: string }[] = [];
  let stopped = false;
  let editStart = 0;
  let editEnd = Number.POSITIVE_INFINITY;
  let stopAt = Number.POSITIVE_INFINITY;
  const graphBefore = graphReadyEvents.length;
  const indexBefore = indexReadyEvents.length;
  const initial: Promise<void>[] = [];
  const view = (index: number) => {
    let done: () => void = () => {};
    initial.push(new Promise<void>((resolve) => (done = resolve)));
    return (async () => {
      let seenGraph = graphReadyEvents.length;
      let seenIndex = indexReadyEvents.length;
      let trigger = "initial";
      while (!stopped) {
        const at = performance.now();
        const result = await fetchRelatedPastScenes(input.viewSceneId, {
          mode: "hybrid",
          graphSeedEntityId: input.seed,
        });
        fetches.push({
          view: index,
          at: at - startedAt,
          trigger,
          graphOutcome: result.graphOutcome ?? null,
          status: result.status,
        });
        result.session?.release();
        done();
        // 次の契機（この project の index-ready か graph-ready）まで待つ。
        while (!stopped) {
          const graph = graphReadyEvents
            .slice(seenGraph)
            .findIndex((event) => event.projectId === input.projectId);
          const indexed = indexReadyEvents
            .slice(seenIndex)
            .findIndex((event) => event.projectId === input.projectId);
          if (graph >= 0 || indexed >= 0) {
            trigger = graph >= 0 ? "graph-ready" : "index-ready";
            seenGraph = graphReadyEvents.length;
            seenIndex = indexReadyEvents.length;
            break;
          }
          if (performance.now() >= stopAt) stopped = true;
          await sleep(5);
        }
      }
    })();
  };
  const editor = async () => {
    await Promise.all(initial);
    editStart = performance.now();
    editEnd = editStart + input.durationMs;
    stopAt = editEnd + input.quietMs;
    let at = 0;
    while (performance.now() < editEnd) {
      at += 1;
      try {
        const text = `Edit ${at} of the CP-4 D′ check at ${Math.round(performance.now())}.`;
        await saveSceneContent(
          input.editSceneId,
          JSON.stringify({
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          }),
        );
        saves.push({ at: performance.now() - startedAt, ok: true });
      } catch (error) {
        saves.push({
          at: performance.now() - startedAt,
          ok: false,
          error: describe(error),
        });
      }
      await sleep(input.editEveryMs);
    }
  };
  const views = Array.from({ length: input.views }, (_, index) => view(index));
  await Promise.all([...views, editor()]);
  const pick = (rows: { projectId: string; at: number }[], from: number) =>
    rows
      .slice(from)
      .filter((event) => event.projectId === input.projectId)
      .map((event) => event.at - startedAt);
  const graphAt = pick(graphReadyEvents, graphBefore);
  const indexAt = pick(indexReadyEvents, indexBefore);
  const startMs = editStart - startedAt;
  const endMs = editEnd - startedAt;
  const within = (rows: number[], from: number, to: number) =>
    rows.filter((at) => at >= from && at < to).length;
  const fetchAt = fetches.map((row) => row.at);
  return {
    durationMs: input.durationMs,
    quietMs: input.quietMs,
    views: input.views,
    editStartMs: startMs,
    editEndMs: endMs,
    saves,
    fetches,
    graphReadyAtMs: graphAt,
    indexReadyAtMs: indexAt,
    duringEdits: {
      graphReady: within(graphAt, startMs, endMs),
      indexReady: within(indexAt, startMs, endMs),
      fetches: within(fetchAt, startMs, endMs),
    },
    afterEdits: {
      graphReady: within(graphAt, endMs, Number.POSITIVE_INFINITY),
      indexReady: within(indexAt, endMs, Number.POSITIVE_INFINITY),
      fetches: within(fetchAt, endMs, Number.POSITIVE_INFINITY),
      lastEventAfterEditEndMs:
        [...graphAt, ...indexAt, ...fetchAt]
          .filter((at) => at >= endMs)
          .sort((a, b) => a - b)
          .at(-1) ?? null,
    },
  };
}

(window as unknown as { cp4Harness: unknown }).cp4Harness = {
  ready: true,
  instrument,
  call,
  openWorkspace: (input: Parameters<typeof openWorkspace>[0]) =>
    guarded(() => openWorkspace(input)),
  selectProject: (input: Parameters<typeof selectProject>[0]) =>
    guarded(() => selectProject(input)),
  api,
  declaration,
  measure,
  buildRaw: (input: Parameters<typeof buildRaw>[0]) =>
    guarded(() => buildRaw(input)),
  buildIndex,
  dprime: {
    heldSample: (input: HeldInput) => guarded(() => heldSample(input)),
    twoViews: (input: Parameters<typeof twoViews>[0]) =>
      guarded(() => twoViews(input)),
    graphReadyCount: () => graphReadyEvents.length,
  },
};
