/**
 * ギャラクシービューのグラフ構築・フィルタ。純関数・I/O 非依存。
 *
 * プロジェクト全体（シーン / Codex エントリ / Chronicle 出来事 / プロット
 * スレッド）を force-directed graph のノード・エッジ集合へ変換する。
 * データ取得は galaxyData.ts、描画は galaxy/GalaxyCanvas.tsx の責務。
 */
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CrossReferenceEntry } from "@/features/codex/crossReference";
import type { CodexRelationRow } from "@/features/codex/codexRelationApi";
import type {
  EventRow,
  SceneEventRow,
  ParticipantRow,
} from "@/features/chronicle/api";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
} from "@/features/plot-threads/api";
import type { GalaxyFilters } from "./types";

export type GalaxyNodeKind = "scene" | "codex" | "event" | "thread";
export type GalaxyEdgeKind =
  | "mention"
  | "relation"
  | "sequence"
  | "eventLink"
  | "participant"
  | "thread";

export interface GalaxyNode {
  /** "scene:<id>" | "codex:<id>" | "event:<id>" | "thread:<id>" */
  id: string;
  kind: GalaxyNodeKind;
  /** 元エンティティの生 id（ジャンプ用） */
  refId: string;
  label: string;
  /** codex のみ type slug、他は null */
  typeSlug: string | null;
  /** thread のみ PlotThreadRow.color、他は null（描画側で解決） */
  color: string | null;
  /** ノードサイズ。applyGalaxyFilters が次数から再計算する */
  val: number;
}

export interface GalaxyLink {
  source: string;
  target: string;
  kind: GalaxyEdgeKind;
  /** relation のみ関係ラベル、他は null */
  label: string | null;
}

export interface GalaxyGraph {
  nodes: GalaxyNode[];
  links: GalaxyLink[];
}

export interface GalaxyGraphInput {
  /** フォルダ含む全 tree ノード（読み順 DFS 用） */
  treeNodes: TreeNodeData[];
  /** 全 codex エントリ（言及 0 のエントリも scenes: [] で含まれる） */
  crossReference: CrossReferenceEntry[];
  relations: CodexRelationRow[];
  events: EventRow[];
  sceneEvents: SceneEventRow[];
  participants: ParticipantRow[];
  threads: PlotThreadRow[];
  threadLinks: PlotThreadLinkRow[];
}

export function buildGalaxyGraph(input: GalaxyGraphInput): GalaxyGraph {
  const nodes: GalaxyNode[] = [];
  const nodeIds = new Set<string>();
  const push = (n: GalaxyNode) => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };

  const order = computeGlobalSceneOrder(input.treeNodes);
  const scenes = input.treeNodes
    .filter((n) => n.nodeType === "scene")
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const s of scenes) {
    push({
      id: `scene:${s.id}`,
      kind: "scene",
      refId: s.id,
      label: s.title,
      typeSlug: null,
      color: null,
      val: 1,
    });
  }
  for (const e of input.crossReference) {
    push({
      id: `codex:${e.entryId}`,
      kind: "codex",
      refId: e.entryId,
      label: e.entryName,
      typeSlug: e.entryType,
      color: null,
      val: 1,
    });
  }
  for (const ev of input.events) {
    push({
      id: `event:${ev.id}`,
      kind: "event",
      refId: ev.id,
      label: ev.title,
      typeSlug: null,
      color: null,
      val: 1,
    });
  }
  for (const th of input.threads) {
    push({
      id: `thread:${th.id}`,
      kind: "thread",
      refId: th.id,
      label: th.name,
      typeSlug: null,
      color: th.color ?? null,
      val: 1,
    });
  }

  const links: GalaxyLink[] = [];
  const linkKeys = new Set<string>();
  const addLink = (
    kind: GalaxyEdgeKind,
    source: string,
    target: string,
    label: string | null = null,
  ) => {
    // 片端が欠けるエッジ（削除済みエンティティ参照等）と自己ループは捨てる
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) {
      return;
    }
    const [a, b] = source < target ? [source, target] : [target, source];
    const key = `${kind}|${a}|${b}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ source, target, kind, label });
  };

  for (let i = 0; i + 1 < scenes.length; i++) {
    addLink("sequence", `scene:${scenes[i].id}`, `scene:${scenes[i + 1].id}`);
  }
  for (const entry of input.crossReference) {
    for (const mention of entry.scenes) {
      addLink("mention", `scene:${mention.sceneId}`, `codex:${entry.entryId}`);
    }
  }
  for (const rel of input.relations) {
    addLink(
      "relation",
      `codex:${rel.fromCodexId}`,
      `codex:${rel.toCodexId}`,
      rel.label ?? null,
    );
  }
  for (const se of input.sceneEvents) {
    addLink("eventLink", `scene:${se.sceneId}`, `event:${se.eventId}`);
  }
  for (const p of input.participants) {
    addLink("participant", `event:${p.eventId}`, `codex:${p.codexEntryId}`);
  }
  for (const tl of input.threadLinks) {
    addLink("thread", `thread:${tl.threadId}`, `scene:${tl.nodeId}`);
  }

  return { nodes, links };
}

/**
 * フィルタ適用。ノード種別 OFF はノードごと（接続エッジも）除去、
 * エッジ種別 OFF はエッジのみ除去。hideOrphans はフィルタ後次数 0 の
 * ノードを落とす。val = 1 + sqrt(degree) を再計算した新グラフを返し、
 * 入力は変異させない。
 */
export function applyGalaxyFilters(
  graph: GalaxyGraph,
  filters: GalaxyFilters,
): GalaxyGraph {
  const nodeKindOn: Record<GalaxyNodeKind, boolean> = {
    scene: filters.nodes.scenes,
    codex: filters.nodes.codex,
    event: filters.nodes.events,
    thread: filters.nodes.threads,
  };

  const keptNodeIds = new Set(
    graph.nodes.filter((n) => nodeKindOn[n.kind]).map((n) => n.id),
  );
  const keptLinks = graph.links.filter(
    (l) =>
      filters.edges[l.kind] &&
      keptNodeIds.has(l.source) &&
      keptNodeIds.has(l.target),
  );

  const degree = new Map<string, number>();
  for (const l of keptLinks) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  const nodes = graph.nodes
    .filter((n) => keptNodeIds.has(n.id))
    .filter((n) => !filters.hideOrphans || (degree.get(n.id) ?? 0) > 0)
    .map((n) => ({ ...n, val: 1 + Math.sqrt(degree.get(n.id) ?? 0) }));

  return { nodes, links: keptLinks.map((l) => ({ ...l })) };
}
