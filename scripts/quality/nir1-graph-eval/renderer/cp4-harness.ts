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
import { loadSceneContent } from "@/features/tree/api";
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
};
