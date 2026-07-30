/**
 * 因果地図 (Causality Diagram) 生成オーケストレータ。
 *
 * timeline_consistency post-effect が出した causality 注釈 (effect シーンに anchor +
 * metadata.cause_scene_id に因シーン) を取り出し、**シーン因果 DAG** を Map の board
 * として**一度きり**スナップショット生成する。correlationBoard と同じ「force layout は
 * in-memory → board/positions/edges を 1 tx で書き込み」方式。
 *
 *   annotations(causality) → extractCausalEdges → buildCausalityDag(実在解決+循環検出)
 *   → force layout → board(scene ノード) + 有向 edge(cause→effect) を snapshot
 *
 * LLM の hallucination は buildCausalityDag が実在シーン解決で吸収済み。
 */
import type { NewMapBoard, NewMapNodePosition, NewMapEdge } from "@/db/schema";
import { invoke } from "@/lib/tauri";
import { listAnnotationsForProject } from "@/features/post-effect/api";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  WorkerForceLayoutEngine,
  type ForceLayoutEngine,
} from "./layouts/forceEngine";
import type { ForceNode, ForceLink } from "./layouts/forceLayout.worker";
import { hashStringToSeed } from "./layouts/seededRandom";
import { listBoards, serializeShowConfig } from "./mapApi";
import type { ShowFlags } from "./types";
import { extractCausalEdges, buildCausalityDag } from "./causalityDag";
import i18next from "@/lib/i18n";

const CAUSAL_EDGE_COLOR = "#dc2626";

export interface GenerateCausalityOptions {
  title?: string;
  engine?: ForceLayoutEngine;
}

export interface CausalityBoardResult {
  /** 解決可能な因果辺が無いときは null (board を作らない)。 */
  boardId: string | null;
  edgeCount: number;
  cycleCount: number;
}

export async function generateCausalityBoard(
  projectId: string,
  opts: GenerateCausalityOptions = {},
): Promise<CausalityBoardResult> {
  // 1. causality 注釈 → cause→effect 生入力。
  const { annotations } = await listAnnotationsForProject({ projectId });
  const edgeInputs = extractCausalEdges(annotations);

  // 2. scene 一覧 (id + title)。Map を開いている前提で tree store から取る。
  const scenes = useTreeStore
    .getState()
    .nodes.filter((n) => n.nodeType === "scene")
    .map((n) => ({ id: n.id, title: n.title }));
  // tree 未ロードで scene が空だと全 causal 辺が解決失敗で落ち、「該当なし」と
  // 誤認させる。それを「シーンが無い」エラーとして明示し masking を防ぐ。
  if (scenes.length === 0) {
    throw new Error(i18next.t("map.causality.noScenes"));
  }

  // 3. DAG 構築 (実在解決・自己ループ除去・dedup・循環検出)。
  const dag = buildCausalityDag(scenes, edgeInputs);
  if (dag.edges.length === 0) {
    // 解決可能な因果辺が無ければ board を作らない (空 board を残さない)。
    // 呼び出し側は boardId===null で「該当なし」を区別する。
    return { boardId: null, edgeCount: 0, cycleCount: 0 };
  }

  // 4. force レイアウト (in-memory)。再生成で揺れない安定 seed。
  const nodes: ForceNode[] = dag.nodes.map((n) => ({
    id: `scene:${n.sceneId}`,
  }));
  const links: ForceLink[] = dag.edges.map((e) => ({
    source: `scene:${e.from}`,
    target: `scene:${e.to}`,
    strength: 0.5,
  }));
  const randomSeed = hashStringToSeed(
    [projectId, dag.nodes.map((n) => n.sceneId).join(",")].join("|"),
  );
  const engine = opts.engine ?? new WorkerForceLayoutEngine();
  const layout = await engine.run({ nodes, links, options: { randomSeed } });
  const posByKey = new Map(layout.positions.map((p) => [p.id, p]));

  // 5. board row (scene ノードを表示)。
  const boardId = crypto.randomUUID();
  const existingBoards = await listBoards(projectId);
  const maxOrder = existingBoards.reduce((m, b) => Math.max(m, b.sortOrder), 0);
  const now = new Date().toISOString();
  const show: ShowFlags = {
    scenes: true,
    codex: false,
    snippets: false,
    notes: false,
    stickies: false,
    aiBranch: false,
    derivedEdges: false,
    userEdges: true,
    frames: false,
  };
  const boardRow: NewMapBoard = {
    id: boardId,
    projectId,
    title: opts.title?.trim() || i18next.t("map.causality.defaultBoardTitle"),
    sortOrder: maxOrder + 1.0,
    mode: "free",
    viewportX: 0,
    viewportY: 0,
    viewportZoom: 1.0,
    showConfig: serializeShowConfig(show),
    colorBy: "none",
    createdAt: now,
    updatedAt: now,
  };

  // 6. positions rows (scene ノード)。
  const positionIdByScene = new Map<string, string>();
  const positionRows: NewMapNodePosition[] = dag.nodes.map((n) => {
    const id = crypto.randomUUID();
    positionIdByScene.set(n.sceneId, id);
    const pos = posByKey.get(`scene:${n.sceneId}`) ?? { x: 0, y: 0 };
    return {
      id,
      boardId,
      nodeRefType: "scene",
      treeNodeId: n.sceneId,
      codexEntryId: null,
      snippetId: null,
      stickyId: null,
      aiBranchId: null,
      x: pos.x,
      y: pos.y,
      pinned: 0,
      zIndex: 0,
      createdAt: now,
      updatedAt: now,
    };
  });

  // 7. edges rows (有向 cause→effect。user-edge snapshot)。
  const edgeRows: NewMapEdge[] = [];
  for (const e of dag.edges) {
    const from = positionIdByScene.get(e.from);
    const to = positionIdByScene.get(e.to);
    if (!from || !to) continue;
    edgeRows.push({
      id: crypto.randomUUID(),
      boardId,
      fromPositionId: from,
      toPositionId: to,
      forwardLabel: e.label ?? null,
      backwardLabel: null,
      labels: "[]",
      style: "solid",
      color: CAUSAL_EDGE_COLOR,
      direction: "forward",
      createdAt: now,
      updatedAt: now,
    });
  }

  // 8. Rust-owned aggregate write で所有権検証と 1 tx 書き込み。
  await invoke("map_write_bundle", {
    payload: {
      kind: "create-board",
      projectId,
      board: boardRow,
      stickies: [],
      positions: positionRows,
      edges: edgeRows,
      frames: [],
    },
  });

  return {
    boardId,
    edgeCount: dag.edges.length,
    cycleCount: dag.cycles.length,
  };
}
