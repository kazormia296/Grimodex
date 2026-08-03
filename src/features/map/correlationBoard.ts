/**
 * 人物相関図 (Character Correlation Diagram) 生成オーケストレータ。
 *
 * Map に新しい board を**一度きり**生成する。中核は「できる限り決定的(exact)で
 * 固め、AI は最小(Phase 1 では AI なし)」。
 *
 *   characters → cross-reference(本文 × rust matcher) → 共起ペア列挙
 *   → authored relations(両端 character) → force layout(in-memory)
 *   → board / positions / edges / frames を型付き集約で snapshot 書き込み
 *
 * エッジは board-local の **user-edge** としてスナップショットし、board は
 * `derivedEdges:false` にする。これで (a) 200-cap 回避、(b) overlay 漏れ防止、
 * (c) codex_relations を汚さない、(d) 自動更新不要、を一括達成する。
 */
import type {
  NewMapBoard,
  NewMapNodePosition,
  NewMapEdge,
  NewMapFrame,
} from "@/db/schema";
import { invoke } from "@/lib/tauri";
import { listCodexEntriesForContext } from "@/features/codex/api";
import { buildCrossReferenceReportForProject } from "@/features/codex/crossReference";
import { listCodexRelations } from "@/features/codex/codexRelationApi";
import { parseTags } from "@/features/codex/components/EntryCard";
import {
  transposeToSceneSets,
  emitCooccurrencePairs,
  cooccurrenceWeightToStrength,
  cooccurrenceWeightToColor,
} from "@/features/codex/cooccurrence";
import {
  WorkerForceLayoutEngine,
  type ForceLayoutEngine,
} from "./layouts/forceEngine";
import type { ForceNode, ForceLink } from "./layouts/forceLayout.worker";
import { hashStringToSeed } from "./layouts/seededRandom";
import { listBoards, serializeShowConfig } from "./mapApi";
import type { ShowFlags } from "./types";
import i18next from "@/lib/i18n";

export interface CorrelationProgress {
  phase: "cross-reference" | "layout" | "writing";
  alpha?: number;
}

export interface GenerateCorrelationOptions {
  characterIds?: string[] | null;
  minSharedScenes: number;
  includeParentFrames: boolean;
  title?: string;
  engine?: ForceLayoutEngine;
}

export interface FrameRect {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Codex ノードの名目サイズ(CodexNode.tsx の width:200, 内容により高さは可変だが
// frame bbox は DOM 計測せず名目値 + padding で算出する)。
const CODEX_NODE_W = 200;
const CODEX_NODE_H = 88;
const FRAME_PADDING = 40;
const REL_EDGE_COLOR = "#7c3aed";
const FRAME_BG = "#f5f5f5";
const FRAME_BORDER = "#cccccc";

/**
 * 共起エッジと relation エッジで同一キー集合を保証するヘルパ。drizzle の複数行
 * `.values([...])` は先頭行のキー集合で全行の列構成が固定されるため、ラベル無しの
 * 共起エッジでも `forwardLabel: null` を明示する。
 */
function buildEdgeRow(args: {
  boardId: string;
  fromPositionId: string;
  toPositionId: string;
  style: "solid" | "dashed";
  color: string;
  direction: "none" | "forward";
  forwardLabel: string | null;
  now: string;
}): NewMapEdge {
  return {
    id: crypto.randomUUID(),
    boardId: args.boardId,
    fromPositionId: args.fromPositionId,
    toPositionId: args.toPositionId,
    forwardLabel: args.forwardLabel,
    backwardLabel: null,
    labels: "[]",
    style: args.style,
    color: args.color,
    direction: args.direction,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/**
 * 同一 parentId グループ(2 件以上)の bbox を作る。DOM 計測せず、Codex ノードの
 * 名目サイズ + padding で算出する。親 entry 名を frame の `title` に入れるだけで
 * 親ノードは作らない(parentId の対人/組織の意味二重性を避ける)。
 */
export function computeParentFrameBboxes(
  characters: Array<{ id: string; parentId?: string | null }>,
  positions: Map<string, { x: number; y: number }>,
  nameById: Map<string, string>,
): FrameRect[] {
  const byParent = new Map<string, typeof characters>();
  for (const c of characters) {
    if (!c.parentId) continue;
    let group = byParent.get(c.parentId);
    if (!group) {
      group = [];
      byParent.set(c.parentId, group);
    }
    group.push(c);
  }

  const rects: FrameRect[] = [];
  for (const [parentId, group] of byParent) {
    if (group.length < 2) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of group) {
      const pos = positions.get(`codex:${c.id}`);
      if (!pos) continue;
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + CODEX_NODE_W);
      maxY = Math.max(maxY, pos.y + CODEX_NODE_H);
    }
    if (!Number.isFinite(minX)) continue;
    rects.push({
      title: nameById.get(parentId) ?? "Group",
      x: minX - FRAME_PADDING,
      y: minY - FRAME_PADDING,
      width: maxX - minX + FRAME_PADDING * 2,
      height: maxY - minY + FRAME_PADDING * 2,
    });
  }

  rects.sort(
    (a, b) => a.x - b.x || a.y - b.y || a.title.localeCompare(b.title),
  );
  return rects;
}

export async function generateCorrelationBoard(
  projectId: string,
  opts: GenerateCorrelationOptions,
  onProgress?: (p: CorrelationProgress) => void,
): Promise<{ boardId: string }> {
  // 1. characters。親 frame の title 解決のため全 entry を一度取得し character を抽出する。
  // id/name/type に加え parentId (共通親 Frame) と tagsCache (force layout の
  // タグ束ね) を読むため match projection では足りない。icon/notes だけ落とした
  // context projection を使う (M10)。
  const allEntries = await listCodexEntriesForContext(projectId);
  const nameById = new Map(allEntries.map((e) => [e.id, e.name]));
  const allCharacters = allEntries.filter((e) => e.type === "character");
  const filterSet =
    opts.characterIds && opts.characterIds.length > 0
      ? new Set(opts.characterIds)
      : null;
  const characters = filterSet
    ? allCharacters.filter((c) => filterSet.has(c.id))
    : allCharacters;
  if (characters.length === 0) {
    throw new Error(i18next.t("map.correlation.noTargetCharacters"));
  }
  const characterIdSet = new Set(characters.map((c) => c.id));

  // 2. cross-reference(本文全文 × rust matcher)。重いが一度きり。
  onProgress?.({ phase: "cross-reference" });
  const report = await buildCrossReferenceReportForProject(projectId);

  // 3. 共起ペア列挙。
  const sceneSets = transposeToSceneSets(report);
  const pairs = emitCooccurrencePairs(sceneSets, {
    entryIds: characterIdSet,
    minSharedScenes: opts.minSharedScenes,
  });
  const maxShared = pairs.reduce((m, p) => Math.max(m, p.sharedScenes), 0);

  // 4. authored relations: 両端が characterIdSet の行だけ採用。
  const allRelations = await listCodexRelations(projectId);
  const relations = allRelations.filter(
    (r) => characterIdSet.has(r.fromCodexId) && characterIdSet.has(r.toCodexId),
  );

  // 5. force レイアウト(in-memory、DB 前)。
  const nodes: ForceNode[] = characters.map((c) => ({
    id: `codex:${c.id}`,
    tags: parseTags(c.tagsCache).map((t) => t.name),
  }));
  const links: ForceLink[] = [];
  for (const p of pairs) {
    links.push({
      source: `codex:${p.aId}`,
      target: `codex:${p.bId}`,
      strength: cooccurrenceWeightToStrength(p.sharedScenes, maxShared),
    });
  }
  for (const r of relations) {
    links.push({
      source: `codex:${r.fromCodexId}`,
      target: `codex:${r.toCodexId}`,
      strength: 0.5,
    });
  }

  // 再生成ごとに揺れないよう安定 seed を作る(boardId(UUID) は使わない)。
  const sortedCharacterIds = [...characterIdSet].sort();
  const randomSeed = hashStringToSeed(
    [
      projectId,
      sortedCharacterIds.join(","),
      String(opts.minSharedScenes),
    ].join("|"),
  );
  const engine = opts.engine ?? new WorkerForceLayoutEngine();
  const layout = await engine.run(
    { nodes, links, options: { randomSeed } },
    (alpha) => onProgress?.({ phase: "layout", alpha }),
  );
  const posByKey = new Map(layout.positions.map((p) => [p.id, p]));

  // 6. board row。mode:"free" を明示(theme だと force layout 自動実行で配置を上書き)。
  onProgress?.({ phase: "writing" });
  const boardId = crypto.randomUUID();
  const existingBoards = await listBoards(projectId);
  const maxOrder = existingBoards.reduce((m, b) => Math.max(m, b.sortOrder), 0);
  const now = new Date().toISOString();
  const show: ShowFlags = {
    scenes: false,
    codex: true,
    snippets: false,
    notes: false,
    stickies: false,
    aiBranch: false,
    derivedEdges: false,
    userEdges: true,
    frames: opts.includeParentFrames,
  };
  const boardRow: NewMapBoard = {
    id: boardId,
    projectId,
    title: opts.title?.trim() || i18next.t("map.correlation.defaultBoardTitle"),
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

  // 7. positions rows(各 character を codex ノードとして配置)。
  const positionIdByCodex = new Map<string, string>();
  const positionRows: NewMapNodePosition[] = characters.map((c) => {
    const id = crypto.randomUUID();
    positionIdByCodex.set(c.id, id);
    const pos = posByKey.get(`codex:${c.id}`) ?? { x: 0, y: 0 };
    return {
      id,
      boardId,
      nodeRefType: "codex",
      treeNodeId: null,
      codexEntryId: c.id,
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

  // 8. edges rows(snapshot as user-edges)。
  const edgeRows: NewMapEdge[] = [];
  for (const p of pairs) {
    const from = positionIdByCodex.get(p.aId);
    const to = positionIdByCodex.get(p.bId);
    if (!from || !to) continue;
    edgeRows.push(
      buildEdgeRow({
        boardId,
        fromPositionId: from,
        toPositionId: to,
        style: "solid",
        color: cooccurrenceWeightToColor(p.sharedScenes, maxShared),
        direction: "none",
        forwardLabel: null,
        now,
      }),
    );
  }
  for (const r of relations) {
    const from = positionIdByCodex.get(r.fromCodexId);
    const to = positionIdByCodex.get(r.toCodexId);
    if (!from || !to) continue;
    edgeRows.push(
      buildEdgeRow({
        boardId,
        fromPositionId: from,
        toPositionId: to,
        style: "dashed",
        color: REL_EDGE_COLOR,
        direction: "forward",
        forwardLabel: r.label ?? r.relationType,
        now,
      }),
    );
  }

  // 9. 共通親 Frame(includeParentFrames 時)。
  const frameRows: NewMapFrame[] = opts.includeParentFrames
    ? computeParentFrameBboxes(characters, posByKey, nameById).map((f) => ({
        id: crypto.randomUUID(),
        boardId,
        title: f.title,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        background: FRAME_BG,
        borderColor: FRAME_BORDER,
        zIndex: -1,
        createdAt: now,
        updatedAt: now,
      }))
    : [];

  // 10. Rust-owned aggregate write で所有権検証と 1 tx 書き込み。
  await invoke("map_write_bundle", {
    payload: {
      kind: "create-board",
      projectId,
      board: boardRow,
      stickies: [],
      positions: positionRows,
      edges: edgeRows,
      frames: frameRows,
    },
  });

  // boardId はクライアント採番なので読み戻し不要。
  return { boardId };
}
