import { generateNKeysBetween } from "fractional-indexing";
import { invoke } from "@/lib/tauri";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { setCurrentRuntimeProjectId } from "@/runtime/projectIdentity";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { createProject, listProjects } from "@/features/project/api";
import { useProjectStore } from "@/features/project/projectStore";
import { listNodes, loadSceneContent } from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";
import { prosemirrorToText } from "@/lib/prosemirror";
import { useDebugLogStore } from "@/lib/debugLog";
import { fetchRelatedPastScenes } from "@/features/related-scenes/fetchRelatedScenes";
import type { Nir1RelatedScenesFetchResult } from "@/features/related-scenes/nir1RelatedScenesFetchTypes";
import {
  listenRelatedScenesIndexReady,
  qualifyNir1Evidence,
} from "@/features/related-scenes/nir1RelatedScenesApi";
import {
  semanticIndexStatus,
  semanticReindexAll,
  semanticSearch,
} from "@/features/semantic-search/api";

interface SceneSeed {
  id: string;
  title: string;
  order: number;
  body: string;
}
interface QuerySeed {
  id: string;
  currentSceneId: string;
  currentOrder: number;
  currentBody: string;
}
let openRevision = 0;
let active: {
  projectId: string;
  scenes: SceneSeed[];
  query: QuerySeed;
} | null = null;

async function prepare(input: {
  workspacePath: string;
  projectId: string;
  language: string;
  scenes: SceneSeed[];
  query: QuerySeed;
}) {
  await invoke("open_workspace", { path: input.workspacePath });
  setCurrentWorkspaceIdentity({
    path: input.workspacePath,
    openRevision: ++openRevision,
  });
  publishCurrentProjectId(input.projectId);
  setCurrentRuntimeProjectId(input.projectId);
  await createProject({
    id: input.projectId,
    title: `NIR-1 ${input.query.id}`,
    language: input.language,
  });
  useProjectStore.setState({
    currentProjectId: input.projectId,
    projects: await listProjects(),
  });
  const scenes = [
    ...input.scenes,
    {
      id: input.query.currentSceneId,
      title: "Current query scene",
      order: input.query.currentOrder,
      body: input.query.currentBody,
    },
  ].sort((a, b) => a.order - b.order);
  const keys = generateNKeysBetween(null, null, scenes.length);
  for (const [index, scene] of scenes.entries()) {
    const content = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: scene.body }] },
      ],
    });
    await invoke("tree_node_create", {
      payload: {
        ...createCanonicalWriteContext("human"),
        id: scene.id,
        projectId: input.projectId,
        parentId: null,
        nodeType: "scene",
        title: scene.title,
        sortOrder: keys[index],
        content,
        canonicalPayload: {
          parentId: null,
          sortOrder: keys[index],
          title: scene.title,
        },
      },
    });
  }
  const nodes = await listNodes(input.projectId);
  if (nodes.length !== scenes.length)
    throw new Error("[artifact] setup scene count mismatch");
  await useTreeStore
    .getState()
    .reloadTreeOrThrow(input.projectId, openRevision);
  usePhaseStore.setState({ resolutionMode: "reading" });
  for (const scene of scenes) {
    // Production extraction terminates every paragraph with a newline. The
    // manifest stores paragraph text, so verify that exact representation.
    if (
      prosemirrorToText(await loadSceneContent(scene.id)) !== `${scene.body}\n`
    )
      throw new Error(`[artifact] persisted source differs: ${scene.id}`);
  }
  active = { projectId: input.projectId, scenes, query: input.query };
  // A real audited query loads the fixed model before the cold-index timer.
  // There are still no reusable scene vectors in this fresh DB.
  const started = performance.now();
  await semanticSearch({
    projectId: input.projectId,
    query: input.query.currentBody,
    limit: 30,
  });
  return {
    modelWarmupMs: performance.now() - started,
    sceneCount: scenes.length,
    indexBefore: await semanticIndexStatus(input.projectId),
  };
}

async function buildRaw() {
  if (!active) throw new Error("[precheck] no prepared case");
  const before = await semanticIndexStatus(active.projectId);
  if (before.indexedChunkCount !== 0)
    throw new Error("[precheck] cold full-build DB already contains vectors");
  const started = performance.now();
  const indexed = await semanticReindexAll(
    active.projectId,
    `nir1-raw-${active.query.id}`,
  );
  const status = await semanticIndexStatus(active.projectId);
  if (
    status.staleChunkCount !== 0 ||
    status.indexedSceneCount !== active.scenes.length ||
    status.nonemptySceneCount !== active.scenes.length ||
    indexed < active.scenes.length
  )
    throw new Error(
      "[artifact] full build did not publish all expected scenes",
    );
  for (const scene of active.scenes) {
    const probe = await semanticSearch({
      projectId: active.projectId,
      query: scene.body,
      limit: 30,
    });
    if (!probe.some((hit) => hit.sceneId === scene.id))
      throw new Error(`[artifact] built source not searchable: ${scene.id}`);
  }
  return { durationMs: performance.now() - started, indexed, status };
}

async function measureRaw() {
  if (!active) throw new Error("[precheck] no prepared case");
  useDebugLogStore.getState().clear();
  const tFetch = performance.now();
  try {
    const results = await fetchRelatedPastScenes(active.query.currentSceneId);
    const tReturn = performance.now();
    const failures = useDebugLogStore
      .getState()
      .entries.filter(
        (entry) =>
          entry.tag === "RelatedScenes" &&
          (entry.level === "warn" || entry.level === "error"),
      );
    return {
      status: failures.length ? "failed" : "ok",
      durationMs: tReturn - tFetch,
      tFetch,
      tReturn,
      results,
      failures: failures.map(({ tag, message }) => ({ tag, message })),
    };
  } catch (error) {
    return {
      status: "failed",
      durationMs: performance.now() - tFetch,
      tFetch,
      tReturn: performance.now(),
      results: [],
      failures: [
        {
          tag: "query",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

/** Opens a byte-verified copy of a normally extracted/approved cold fixture.
 * No extraction, authoring write, or fixture resealing occurs in comparison. */
async function openPrepared(input: Parameters<typeof prepare>[0]) {
  await invoke("open_workspace", { path: input.workspacePath });
  setCurrentWorkspaceIdentity({
    path: input.workspacePath,
    openRevision: ++openRevision,
  });
  publishCurrentProjectId(input.projectId);
  setCurrentRuntimeProjectId(input.projectId);
  useProjectStore.setState({
    currentProjectId: input.projectId,
    projects: await listProjects(),
  });
  await useTreeStore
    .getState()
    .reloadTreeOrThrow(input.projectId, openRevision);
  useTreeStore.setState({ activeSceneId: input.query.currentSceneId });
  usePhaseStore.setState({ resolutionMode: "reading" });
  const scenes = [
    ...input.scenes,
    {
      id: input.query.currentSceneId,
      title: "Current query scene",
      order: input.query.currentOrder,
      body: input.query.currentBody,
    },
  ];
  for (const scene of scenes) {
    if (
      prosemirrorToText(await loadSceneContent(scene.id)) !== `${scene.body}\n`
    )
      throw new Error(`[artifact] prepared source differs: ${scene.id}`);
  }
  active = { projectId: input.projectId, scenes, query: input.query };
  const started = performance.now();
  await semanticSearch({
    projectId: input.projectId,
    query: input.query.currentBody,
    limit: 30,
  });
  return {
    modelWarmupMs: performance.now() - started,
    sceneCount: scenes.length,
    indexBefore: await semanticIndexStatus(input.projectId),
  };
}

let pendingHybrid: Nir1RelatedScenesFetchResult | null = null;
async function measureHybrid() {
  if (!active || pendingHybrid)
    throw new Error("[precheck] hybrid lifecycle incomplete");
  useDebugLogStore.getState().clear();
  const tFetch = performance.now();
  const sample = await fetchRelatedPastScenes(active.query.currentSceneId, {
    mode: "hybrid",
  });
  const tReturn = performance.now();
  pendingHybrid = sample;
  const results = sample.result.scenes.map((row) =>
    "kind" in row
      ? {
          sceneId: row.sceneId,
          sceneTitle: row.sceneTitle,
          chunkText: row.kind === "ir" ? "" : row.raw.chunkText,
        }
      : row,
  );
  const failures = useDebugLogStore
    .getState()
    .entries.filter(
      (entry) =>
        entry.tag === "RelatedScenes" &&
        (entry.level === "warn" || entry.level === "error"),
    );
  return {
    status:
      sample.status !== "completed" ||
      sample.rawStatus !== "completed" ||
      failures.length
        ? "failed"
        : sample.completion?.outcome === "timeout"
          ? "completed-safe-fallback"
          : "ok",
    durationMs: tReturn - tFetch,
    tFetch,
    tReturn,
    timing: sample.timing,
    initialSnapshot: sample.initialSnapshot,
    completion: sample.completion,
    results,
    rawScenes: sample.rawScenes,
    result: sample.result,
    failures: failures.map(({ tag, message }) => ({ tag, message })),
  };
}

async function finalizeHybrid() {
  const sample = pendingHybrid;
  pendingHybrid = null;
  if (!sample) return [];
  try {
    const rows =
      sample.result.kind === "fused"
        ? sample.result.scenes.filter((row) => row.kind !== "raw")
        : [];
    const qualified = [];
    for (const row of rows) {
      const result = await qualifyNir1Evidence(
        row.ir.validatedEvidence.navigationIdentity,
      );
      qualified.push({
        sceneId: row.sceneId,
        status: result.status,
        bindingMatches:
          result.status === "qualified" &&
          result.sceneId === row.sceneId &&
          result.queryBinding === sample.queryBinding,
        sourceVersion:
          result.status === "qualified" ? result.sourceVersion : null,
      });
    }
    return qualified;
  } finally {
    sample.session?.release();
  }
}

async function buildIr() {
  if (!active) throw new Error("[precheck] no prepared case");
  let readyEvents = 0;
  const project = active.projectId;
  const unlisten = await listenRelatedScenesIndexReady((id) => {
    if (id === project) readyEvents++;
  });
  const started = performance.now();
  const probes = [];
  try {
    while (performance.now() - started < 30000) {
      const sample = await measureHybrid();
      const evidence = await finalizeHybrid();
      probes.push({
        status: sample.status,
        initialSnapshot: sample.initialSnapshot,
        completion: sample.completion,
      });
      if (
        sample.initialSnapshot?.indexUsable &&
        sample.completion?.outcome === "ir-ready"
      ) {
        return {
          durationMs: performance.now() - started,
          readyEvents,
          probes,
          evidence,
          results: sample.results,
          result: sample.result,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      "[artifact] IR did not become usable through its actual query route",
    );
  } finally {
    unlisten();
  }
}

async function buildCombined() {
  const started = performance.now();
  const raw = await buildRaw();
  const ir = await buildIr();
  return { durationMs: performance.now() - started, raw, ir };
}

Object.assign(window, {
  nir1Evaluation: {
    prepare,
    buildRaw,
    measureRaw,
    openPrepared,
    measureHybrid,
    finalizeHybrid,
    buildIr,
    buildCombined,
    ready: true,
  },
});
