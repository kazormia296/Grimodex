// 融合の枠の評価（段階 1）：Raw の満杯率を測る renderer 側の部品。
//
// L0 の `scripts/quality/nir1-retrieval/renderer.ts` の prepare／buildRaw／measureRaw を
// 写したもの（既存の file は変えない）。違いは次のとおり。
// - Scene の本文は複数段落の ProseMirror doc（PD の原稿を段落ごとに入れる）。
// - 書込みは L0 と同じ canonical writer（`tree_node_create`、human の write context）。
// - 返すのは件数と Scene の位置（番号）だけ。本文・題名・抜粋（chunkText）は返さない。
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
import { RELATED_SCENES_FETCH_LIMIT } from "@/features/related-scenes/relatedScenesConfig";
import { buildSemanticRecallQuery } from "@/features/chat/semanticRecall";
import {
  semanticIndexStatus,
  semanticReindexAll,
  semanticSearch,
} from "@/features/semantic-search/api";

interface SceneSeed {
  /** 読書順の位置（1 始まり）。 */
  position: number;
  paragraphs: string[];
}

let openRevision = 0;
let active: {
  projectId: string;
  positions: Map<string, number>;
  sceneCount: number;
} | null = null;

const sceneId = (position: number) => `s${String(position).padStart(4, "0")}`;

async function prepare(input: {
  workspacePath: string;
  projectId: string;
  language: "ja" | "en";
  scenes: SceneSeed[];
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
    title: "Fusion slot evaluation",
    language: input.language,
  });
  useProjectStore.setState({
    currentProjectId: input.projectId,
    projects: await listProjects(),
  });
  const scenes = [...input.scenes].sort((a, b) => a.position - b.position);
  const keys = generateNKeysBetween(null, null, scenes.length);
  for (const [index, scene] of scenes.entries()) {
    const title = `S${scene.position}`;
    const content = JSON.stringify({
      type: "doc",
      content: scene.paragraphs.map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    });
    await invoke("tree_node_create", {
      payload: {
        ...createCanonicalWriteContext("human"),
        id: sceneId(scene.position),
        projectId: input.projectId,
        parentId: null,
        nodeType: "scene",
        title,
        sortOrder: keys[index],
        content,
        canonicalPayload: { parentId: null, sortOrder: keys[index], title },
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
    // 製品の抽出は段落ごとに改行で終える。保存された本文がそのまま読めるかを確かめる。
    const expected = scene.paragraphs.map((p) => `${p}\n`).join("");
    if (
      prosemirrorToText(await loadSceneContent(sceneId(scene.position))) !==
      expected
    )
      throw new Error(
        `[artifact] persisted source differs: ${sceneId(scene.position)}`,
      );
  }
  active = {
    projectId: input.projectId,
    positions: new Map(scenes.map((s) => [sceneId(s.position), s.position])),
    sceneCount: scenes.length,
  };
  return { sceneCount: scenes.length };
}

async function buildRaw() {
  if (!active) throw new Error("[precheck] no prepared case");
  const before = await semanticIndexStatus(active.projectId);
  if (before.indexedChunkCount !== 0)
    throw new Error("[precheck] fresh DB already contains vectors");
  const started = performance.now();
  const indexed = await semanticReindexAll(
    active.projectId,
    `fusion-slot-${active.projectId}`,
  );
  const status = await semanticIndexStatus(active.projectId);
  if (
    status.staleChunkCount !== 0 ||
    status.indexedSceneCount !== active.sceneCount ||
    status.nonemptySceneCount !== active.sceneCount ||
    indexed < active.sceneCount
  )
    throw new Error(
      "[artifact] full build did not publish all expected scenes",
    );
  return {
    durationMs: performance.now() - started,
    indexedChunkCount: status.indexedChunkCount,
    indexedSceneCount: status.indexedSceneCount,
  };
}

/**
 * 製品の `fetchRelatedPastScenes`（Raw だけ。hybrid でない）を呼び、件数と位置を返す。
 * 上位 30 チャンクの内訳は、同じ query 文字列で `semanticSearch` を別に呼んで数える
 * （同じ呼出しの捕捉ではなく再問合せ）。
 */
async function measure(position: number) {
  if (!active) throw new Error("[precheck] no prepared case");
  const positions = active.positions;
  const id = sceneId(position);
  const call = async () => {
    useDebugLogStore.getState().clear();
    const started = performance.now();
    const results = await fetchRelatedPastScenes(id);
    const durationMs = performance.now() - started;
    const failureTags = useDebugLogStore
      .getState()
      .entries.filter(
        (entry) =>
          entry.tag === "RelatedScenes" &&
          (entry.level === "warn" || entry.level === "error"),
      )
      .map(() => "RelatedScenes");
    return {
      durationMs,
      failureTags,
      rawPositions: results.map((row) => positions.get(row.sceneId) ?? -1),
    };
  };
  try {
    const first = await call();
    const second = await call();
    const body = prosemirrorToText(await loadSceneContent(id));
    const query = buildSemanticRecallQuery({
      userMessage: "",
      sceneBody: body,
    });
    const hits = await semanticSearch({
      projectId: active.projectId,
      query,
      limit: RELATED_SCENES_FETCH_LIMIT,
    });
    const hitPositions = hits.map((hit) => positions.get(hit.sceneId) ?? -1);
    const earlier = hitPositions.filter((p) => p > 0 && p < position);
    return {
      status:
        first.failureTags.length || second.failureTags.length ? "failed" : "ok",
      failureTags: [...first.failureTags, ...second.failureTags],
      rawCount: first.rawPositions.length,
      rawPositions: first.rawPositions,
      repeatStable:
        JSON.stringify(first.rawPositions) ===
        JSON.stringify(second.rawPositions),
      durationMs: first.durationMs,
      top30: {
        method: "re-query",
        limit: RELATED_SCENES_FETCH_LIMIT,
        returned: hits.length,
        sameScene: hitPositions.filter((p) => p === position).length,
        laterScene: hitPositions.filter((p) => p > position).length,
        earlierChunks: earlier.length,
        earlierDistinctScenes: new Set(earlier).size,
        unknownScene: hitPositions.filter((p) => p < 0).length,
      },
    };
  } catch (error) {
    return {
      status: "failed",
      failureTags: [
        error instanceof Error && error.message.startsWith("[")
          ? error.message.slice(0, error.message.indexOf("]") + 1)
          : "query",
      ],
      rawCount: null,
      rawPositions: [],
      repeatStable: null,
      durationMs: null,
      top30: null,
    };
  }
}

Object.assign(window, {
  fusionSlotEvaluation: { prepare, buildRaw, measure, ready: true },
});
