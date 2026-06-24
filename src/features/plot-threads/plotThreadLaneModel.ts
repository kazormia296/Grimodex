import { cmpKeys } from "@/features/tree/fractionalIndex";
import {
  PLOT_PHASE_TYPES,
  type PlotPhaseType,
  type PlotBranchKind,
} from "@/db/schema";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
  PlotThreadBranchRow,
} from "./api";

/** TimelineViewport の LANE_Y(=60) と整合する scheduled ベースライン。 */
export const LANE_TOP = 60;
export const LANE_HEIGHT = 56;
/** 連続共起がこの列数以上続いたら 1 トラックへ束ねる（単発共起は束ねない）。 */
export const MIN_BUNDLE_SPAN = 3;
/** 交差最小化スイープのパス数（収束待ちにせず固定＝決定性）。 */
const ORDER_PASSES = 8;

export function laneY(index: number): number {
  return LANE_TOP + index * LANE_HEIGHT;
}

export interface PlotLaneMarker {
  linkId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  /** シーン x インデックス（px 変換は viewport の xOf に委ねる）。 */
  x: number;
  /** その列でのスレッド Y（px・スロット由来）。もはや単一グローバル行は無い。 */
  y: number;
}
/** スレッド線の連続セグメント。x はシーン index（xOf 変換）、y は px（スロット Y）。
 *  同スロット run は y1===y2（水平帯）。スロット変化は短い斜めブリッジ（y1!==y2）。 */
export interface PlotLineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface PlotLane {
  thread: PlotThreadRow;
  /** 最初の生存列の Y（左ガター・ラベル＋背景線アンカー用）。線形状は端点で駆動。 */
  y: number;
  markers: PlotLaneMarker[];
  /** 連続線セグメント（隣接列の連なり。merge/branch の継ぎ目で切れる）。 */
  lineSegments: PlotLineSegment[];
  /** 「完結」終端の x（線が自走で終わる＝最後のビートが merge でないとき）。 */
  terminusX: number | null;
  /** 生存列ごとのスロット番号（Y = laneTop + slot*LANE_HEIGHT）。 */
  slotByColumn: Map<number, number>;
  /** 束ね（subway トラック）に属するならその id、でなければ null。 */
  bundleId: string | null;
}
/** 分岐 / 合流のコネクタ。あるシーン x で fromY↔toY のレーン間を繋ぐ。
 *  fromY/toY は at 列のローカルスロットから再計算する（#5 = グローバル行から読まない）。 */
export interface PlotConnector {
  id: string;
  x: number;
  fromY: number;
  toY: number;
  kind: PlotBranchKind;
  color: string | null;
}
/** 束ね（subway トラック）。区間 [enterX,exitX] でメンバーが 1 スロットを共有する。 */
export interface PlotBundle {
  id: string;
  threadIds: string[];
  enterX: number;
  exitX: number;
  baseSlot: number;
  /** MVP は常に collapsed（帯スロットに重畳）。サブレーン fan-out は phase 2。 */
  collapsed: boolean;
}
export interface PlotLaneModel {
  lanes: PlotLane[];
  /** 最大シーン index（px 変換は viewport 側）。 */
  contentWidth: number;
  contentHeight: number;
  /** 2 本以上のスレッドがマーカーを持つシーン x（昇順・収束ハイライト用）。 */
  convergences: number[];
  /** 分岐 / 合流コネクタ（from/to スレッドと at シーンが揃うものだけ）。 */
  connectors: PlotConnector[];
  /** 束ね（subway トラック）一覧。 */
  bundles: PlotBundle[];
}

const PHASE_ORDER: Record<PlotPhaseType, number> = PLOT_PHASE_TYPES.reduce(
  (acc, p, i) => {
    acc[p] = i;
    return acc;
  },
  {} as Record<PlotPhaseType, number>,
);

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * プロットスレッドの束ねレイアウト（subway / storyline 可視化）を生成する純関数。
 *
 * 概念モデル: 層 = シーン列（x 固定）、ノード = (スレッド, 列) の生存セル、
 * 辺 = 連続列の同一スレッド。唯一の自由変数は各セルの Y スロット順 + 束ね。
 * 5 段パイプライン: PREP →（セッション化）→ 順序（交差最小化）→ スロット（最小移動）→ 出力。
 *
 * 決定性: 乱数/Date.now 禁止。初期順 = (sortOrder,id)。固定 8 パス。全比較子に
 * (sortOrder→id) 最終タイブレーク。Map/Set 反復順に順序判断を依存させない。
 */
export function buildPlotLaneModel(args: {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  sceneX: Map<string, number>;
  laneTop?: number;
  branches?: PlotThreadBranchRow[];
  /** scheduled シーン数。これ以上の x（story-time の未配置）は描かない。既定 Infinity。 */
  scheduledCount?: number;
}): PlotLaneModel {
  const {
    threads,
    links,
    sceneX,
    laneTop = LANE_TOP,
    branches = [],
    scheduledCount = Infinity,
  } = args;

  const yOf = (slot: number) => laneTop + slot * LANE_HEIGHT;

  // ───────── PREP ─────────
  const orderedThreads = [...threads].sort((a, b) => {
    const c = cmpKeys(a.sortOrder, b.sortOrder);
    return c !== 0 ? c : cmpId(a.id, b.id);
  });
  const globalRank = new Map<string, number>(
    orderedThreads.map((t, i) => [t.id, i]),
  );

  const linksByThread = new Map<string, PlotThreadLinkRow[]>();
  for (const l of links) {
    const arr = linksByThread.get(l.threadId);
    if (arr) arr.push(l);
    else linksByThread.set(l.threadId, [l]);
  }

  // merge(from→to)@X = from が X で畳まれる / branch(from→to)@X = to が X で生まれる。
  // 線の継ぎ目（run 分割）に使うため、スレッド別に「列番号」の集合へ落とす。
  const mergeColsByThread = new Map<string, Set<number>>();
  const branchColsByThread = new Map<string, Set<number>>();
  const addCol = (m: Map<string, Set<number>>, k: string, v: number) => {
    const s = m.get(k);
    if (s) s.add(v);
    else m.set(k, new Set([v]));
  };
  for (const b of branches) {
    const x = sceneX.get(b.atNodeId);
    if (x === undefined || x >= scheduledCount) continue;
    if (b.kind === "merge") addCol(mergeColsByThread, b.fromThreadId, x);
    else addCol(branchColsByThread, b.toThreadId, x);
  }

  interface Prep {
    thread: PlotThreadRow;
    markers: PlotLaneMarker[]; // y は後で埋める
    lo: number; // 生存スパン開始列（override 反映）
    hi: number; // 生存スパン終了列
    living: boolean;
  }

  let maxX = 0;
  const preps: Prep[] = orderedThreads.map((thread) => {
    const raw = linksByThread.get(thread.id) ?? [];
    const markers: PlotLaneMarker[] = raw
      .filter((l) => {
        const x = sceneX.get(l.nodeId);
        return x !== undefined && x < scheduledCount;
      })
      .map((l) => {
        const x = sceneX.get(l.nodeId)!;
        if (x > maxX) maxX = x;
        return {
          linkId: l.id,
          nodeId: l.nodeId,
          phaseType: l.phaseType,
          x,
          y: 0,
        };
      })
      .sort((a, b) => {
        if (a.x !== b.x) return a.x - b.x;
        const p =
          (PHASE_ORDER[a.phaseType] ?? 0) - (PHASE_ORDER[b.phaseType] ?? 0);
        return p !== 0 ? p : cmpId(a.linkId, b.linkId);
      });

    // 生存スパン = [min(firstMarkerX,start), max(lastMarkerX,end)]。override は *延長* で
    // あってマーカーを切り捨てない（start がマーカーより後でも実ビートをスパン外へ追い出さない）。
    // override は scheduled 内のみ採用。
    const validOverride = (id: string | null): number | undefined => {
      if (!id) return undefined;
      const x = sceneX.get(id);
      return x !== undefined && x < scheduledCount ? x : undefined;
    };
    const startX = validOverride(thread.startNodeId ?? null);
    const endX = validOverride(thread.endNodeId ?? null);
    const firstMarkerX = markers.length ? markers[0].x : undefined;
    const lastMarkerX = markers.length
      ? markers[markers.length - 1].x
      : undefined;
    const loCands = [firstMarkerX, startX].filter(
      (v): v is number => v !== undefined,
    );
    const hiCands = [lastMarkerX, endX].filter(
      (v): v is number => v !== undefined,
    );
    let lo = loCands.length ? Math.min(...loCands) : undefined;
    let hi = hiCands.length ? Math.max(...hiCands) : undefined;
    if (lo === undefined) lo = hi;
    if (hi === undefined) hi = lo;
    const living = lo !== undefined;
    // start/end のみ(マーカー無し)で start>end の倒錯入力は単一列にクランプ。
    if (living && (hi as number) < (lo as number)) hi = lo;
    if (living && (hi as number) > maxX) maxX = hi as number;

    return {
      thread,
      markers,
      lo: lo ?? 0,
      hi: hi ?? 0,
      living,
    };
  });

  const prepByThread = new Map(preps.map((p) => [p.thread.id, p]));

  // ───────── セッション化（束ね導出: エッジ + 連続共起 ≥ MIN_BUNDLE_SPAN）─────────
  // union-find をソート配列に materialize（決定性）。生存スレッドのみ対象。
  const livingThreads = preps.filter((p) => p.living).map((p) => p.thread.id);
  const parent = new Map<string, string>(livingThreads.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // 経路圧縮（決定性に影響しない）
    let cur = x;
    while (parent.get(cur) !== r) {
      const nxt = parent.get(cur)!;
      parent.set(cur, r);
      cur = nxt;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // 代表は (globalRank,id) 小さい方へ寄せる（決定的）。
    const keep = globalRank.get(ra)! - globalRank.get(rb)! || cmpId(ra, rb);
    if (keep <= 0) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  // 束ねは「並走（連続共起）」のみで導出する。branch/merge エッジは *接続点*（ファン
  // イン/アウト）でありトラック束ねではない（1 列重なりのエッジでも束ねると両端が同一
  // スロットへ畳まれ分岐が消える）。エッジは connectors（ランプ）で表現する。
  // エッジの directional/partial-span 束ね（merge=X 以降 / branch=X 以前のみ）は
  // fan-out と一緒に phase 2 へ送る。共起 ≥ MIN_BUNDLE_SPAN が並走束ねの本線。
  // 共起由来: 生存スパンが MIN_BUNDLE_SPAN 列以上重なるペアを union。
  for (let i = 0; i < livingThreads.length; i++) {
    for (let j = i + 1; j < livingThreads.length; j++) {
      const a = prepByThread.get(livingThreads[i])!;
      const c = prepByThread.get(livingThreads[j])!;
      const overlap = Math.min(a.hi, c.hi) - Math.max(a.lo, c.lo) + 1;
      if (overlap >= MIN_BUNDLE_SPAN) union(a.thread.id, c.thread.id);
    }
  }

  // コンポーネント → 実束ね（メンバー ≥2 かつ実際に ≥2 が同時生存する列がある）。
  const componentMembers = new Map<string, string[]>();
  for (const id of livingThreads) {
    const r = find(id);
    const arr = componentMembers.get(r);
    if (arr) arr.push(id);
    else componentMembers.set(r, [id]);
  }
  // bundleId は決定的に（globalRank 順メンバー）。thread→bundle と active 区間を作る。
  const bundleByThread = new Map<string, string>();
  const bundleSpan = new Map<
    string,
    { enterX: number; exitX: number; threadIds: string[] }
  >();
  const componentRoots = [...componentMembers.keys()].sort(
    (a, b) => globalRank.get(a)! - globalRank.get(b)! || cmpId(a, b),
  );
  for (const root of componentRoots) {
    const members = componentMembers
      .get(root)!
      .slice()
      .sort((a, b) => globalRank.get(a)! - globalRank.get(b)! || cmpId(a, b));
    if (members.length < 2) continue;
    // ≥2 メンバーが同時に生存する列範囲。
    let enterX: number | undefined;
    let exitX: number | undefined;
    for (let c = 0; c <= maxX; c++) {
      let cnt = 0;
      for (const m of members) {
        const p = prepByThread.get(m)!;
        if (p.lo <= c && c <= p.hi) cnt++;
        if (cnt >= 2) break;
      }
      if (cnt >= 2) {
        if (enterX === undefined) enterX = c;
        exitX = c;
      }
    }
    if (enterX === undefined || exitX === undefined) continue; // 同時生存しない → 束ねない
    const id = `bundle:${members.join("+")}`;
    bundleSpan.set(id, { enterX, exitX, threadIds: members });
    for (const m of members) bundleByThread.set(m, id);
  }

  // (thread,列) → エンティティ id（束ね区間内は bundleId、それ以外は threadId）。
  const entityOf = (threadId: string, c: number): string => {
    const bid = bundleByThread.get(threadId);
    if (bid) {
      const span = bundleSpan.get(bid)!;
      if (span.enterX <= c && c <= span.exitX) return bid;
    }
    return threadId;
  };
  const entitySortKey = new Map<string, number>();
  const setEntityKey = (entityId: string, rank: number) => {
    const cur = entitySortKey.get(entityId);
    if (cur === undefined || rank < cur) entitySortKey.set(entityId, rank);
  };

  // ───────── 列ごとのエンティティ集合 ─────────
  const entitiesAt = new Map<number, Set<string>>();
  for (const p of preps) {
    if (!p.living) continue;
    for (let c = p.lo; c <= p.hi; c++) {
      const e = entityOf(p.thread.id, c);
      setEntityKey(e, globalRank.get(p.thread.id)!);
      const set = entitiesAt.get(c);
      if (set) set.add(e);
      else entitiesAt.set(c, new Set([e]));
    }
  }
  const columns: number[] = [...entitiesAt.keys()].sort((a, b) => a - b);

  // ───────── Stage 1: ORDERING（交差最小化・加重メディアン + best-snapshot）─────────
  type Order = Map<number, string[]>;
  const initial: Order = new Map();
  for (const c of columns) {
    const arr = [...entitiesAt.get(c)!].sort(
      (a, b) => entitySortKey.get(a)! - entitySortKey.get(b)! || cmpId(a, b),
    );
    initial.set(c, arr);
  }
  const posOf = (order: Order): Map<number, Map<string, number>> => {
    const m = new Map<number, Map<string, number>>();
    for (const [c, arr] of order) {
      const pm = new Map<string, number>();
      arr.forEach((e, i) => pm.set(e, i));
      m.set(c, pm);
    }
    return m;
  };
  const countCrossings = (
    order: Order,
    pos: Map<number, Map<string, number>>,
  ): number => {
    let total = 0;
    for (let k = 0; k < columns.length; k++) {
      const cA = columns[k];
      const cB = cA + 1;
      const arrB = order.get(cB);
      if (!arrB) continue;
      const posB = pos.get(cB)!;
      // 両列に存在するエンティティを cA 順に並べ、その cB 順の反転数を数える。
      const shared = order
        .get(cA)!
        .filter((e) => posB.has(e))
        .map((e) => posB.get(e)!);
      for (let i = 0; i < shared.length; i++) {
        for (let j = i + 1; j < shared.length; j++) {
          if (shared[i] > shared[j]) total++;
        }
      }
    }
    return total;
  };
  const cloneOrder = (order: Order): Order => {
    const m: Order = new Map();
    for (const [c, arr] of order) m.set(c, arr.slice());
    return m;
  };

  const order: Order = cloneOrder(initial);
  const pos = posOf(order);
  let best = cloneOrder(order);
  let bestCross = countCrossings(order, pos);

  for (let pass = 0; pass < ORDER_PASSES; pass++) {
    const leftToRight = pass % 2 === 0;
    const seq = leftToRight ? columns : [...columns].reverse();
    for (const c of seq) {
      const adj = leftToRight ? c - 1 : c + 1;
      const adjPos = pos.get(adj);
      if (!adjPos) continue; // 端列はアンカー（並べ替えない）
      const cur = order.get(c)!;
      const keyed = cur.map((e, i) => ({
        e,
        // 隣接（確定済）列での位置＝メディアン。無ければ現位置を保つ。
        m: adjPos.has(e) ? adjPos.get(e)! : i,
      }));
      keyed.sort(
        (a, b) =>
          a.m - b.m ||
          entitySortKey.get(a.e)! - entitySortKey.get(b.e)! ||
          cmpId(a.e, b.e),
      );
      const next = keyed.map((k) => k.e);
      order.set(c, next);
      const pm = new Map<string, number>();
      next.forEach((e, i) => pm.set(e, i));
      pos.set(c, pm);
    }
    const cr = countCrossings(order, pos);
    if (cr < bestCross) {
      bestCross = cr;
      best = cloneOrder(order);
    }
  }

  // ───────── Stage 3: COMPACTION（最小移動スロット・決定的）─────────
  // 列ごとにランク順で、前列の同エンティティ Y に最も近いスロットへ（順序を保ちつつ重なり回避）。
  const slotAt = new Map<number, Map<string, number>>();
  const prevSlot = new Map<string, number>();
  let maxSlot = -1;
  for (const c of columns) {
    const ord = best.get(c)!;
    let last = -1;
    const m = new Map<string, number>();
    for (const e of ord) {
      const desired = prevSlot.has(e) ? prevSlot.get(e)! : last + 1;
      const slot = Math.max(desired, last + 1);
      m.set(e, slot);
      last = slot;
      if (slot > maxSlot) maxSlot = slot;
    }
    slotAt.set(c, m);
    for (const [e, s] of m) prevSlot.set(e, s);
  }

  const slotOfThreadAt = (threadId: string, c: number): number | undefined =>
    slotAt.get(c)?.get(entityOf(threadId, c));

  // 非生存スレッド（マーカー無し・override 無し）は末尾へ積む（線が無いので順序自由）。
  const appendedSlot = new Map<string, number>();
  for (const p of preps) {
    if (p.living) continue;
    maxSlot += 1;
    appendedSlot.set(p.thread.id, maxSlot);
  }

  // ───────── 出力: レーン ─────────
  const lanes: PlotLane[] = preps.map((p) => {
    const thread = p.thread;
    if (!p.living) {
      const slot = appendedSlot.get(thread.id)!;
      return {
        thread,
        y: yOf(slot),
        markers: [],
        lineSegments: [],
        terminusX: null,
        slotByColumn: new Map(),
        bundleId: null,
      };
    }
    const slotByColumn = new Map<number, number>();
    for (let c = p.lo; c <= p.hi; c++) {
      const s = slotOfThreadAt(thread.id, c);
      if (s !== undefined) slotByColumn.set(c, s);
    }
    const markers = p.markers.map((mk) => ({
      ...mk,
      y: yOf(slotByColumn.get(mk.x) ?? slotByColumn.get(p.lo) ?? 0),
    }));

    // run 分割（生存スパン上で merge-out 後 / branch-in 前に切る）。
    const mergeCols = mergeColsByThread.get(thread.id);
    const branchCols = branchColsByThread.get(thread.id);
    const runs: Array<[number, number]> = [];
    let runStart = p.lo;
    for (let c = p.lo; c <= p.hi; c++) {
      const isLast = c === p.hi;
      let breakHere = isLast;
      if (!isLast && (mergeCols?.has(c) || branchCols?.has(c + 1))) {
        breakHere = true;
      }
      if (breakHere) {
        runs.push([runStart, c]);
        runStart = c + 1;
      }
    }

    const lineSegments: PlotLineSegment[] = [];
    for (const [rs, re] of runs) {
      if (re === rs) continue; // 単一列 run は点（ゼロ長線は描かない）
      let i = rs;
      while (i < re) {
        const s = slotByColumn.get(i) ?? 0;
        let j = i;
        while (j + 1 <= re && (slotByColumn.get(j + 1) ?? 0) === s) j++;
        if (j > i) {
          lineSegments.push({ x1: i, y1: yOf(s), x2: j, y2: yOf(s) });
        }
        if (j < re) {
          const sNext = slotByColumn.get(j + 1) ?? 0;
          lineSegments.push({
            x1: j,
            y1: yOf(s),
            x2: j + 1,
            y2: yOf(sNext),
          });
          i = j + 1;
        } else {
          i = j + 1;
        }
      }
    }

    // 終端キャップ: 最後の run が自走（merge でない）かつ長さを持つなら hi。
    const lastRun = runs[runs.length - 1];
    const terminusX =
      lastRun && lastRun[1] > lastRun[0] && !mergeCols?.has(lastRun[1])
        ? lastRun[1]
        : null;

    return {
      thread,
      y: yOf(slotByColumn.get(p.lo) ?? 0),
      markers,
      lineSegments,
      terminusX,
      slotByColumn,
      bundleId: bundleByThread.get(thread.id) ?? null,
    };
  });
  const laneByThread = new Map(lanes.map((l) => [l.thread.id, l]));

  // ───────── 収束（≥2 レーンがマーカーを持つ列）─────────
  const xLaneCount = new Map<number, number>();
  for (const p of preps) {
    for (const x of new Set(p.markers.map((m) => m.x))) {
      xLaneCount.set(x, (xLaneCount.get(x) ?? 0) + 1);
    }
  }
  const convergences = [...xLaneCount.entries()]
    .filter(([, c]) => c >= 2)
    .map(([x]) => x)
    .sort((a, b) => a - b);

  // ───────── 分岐 / 合流コネクタ（fromY/toY は at 列のスロット由来 = #5）─────────
  // 入力 branches 配列順に出力順を依存させない（listPlotThreadBranches は orderBy 無し・
  // CRUD で並びが変動）。決定性のため (id) 安定キーで整列してから構築する。
  const orderedBranches = [...branches].sort((a, b) => cmpId(a.id, b.id));
  const connectors: PlotConnector[] = orderedBranches.flatMap((b) => {
    const from = laneByThread.get(b.fromThreadId);
    const to = laneByThread.get(b.toThreadId);
    const x = sceneX.get(b.atNodeId);
    if (!from || !to || x === undefined || x >= scheduledCount) return [];
    const fromY = from.slotByColumn.has(x)
      ? yOf(from.slotByColumn.get(x)!)
      : from.y;
    const toY = to.slotByColumn.has(x) ? yOf(to.slotByColumn.get(x)!) : to.y;
    return [
      {
        id: b.id,
        x,
        fromY,
        toY,
        kind: b.kind,
        color: from.thread.color,
      },
    ];
  });

  // ───────── 束ね出力 ─────────
  const bundles: PlotBundle[] = componentRoots.flatMap((root) => {
    const members = componentMembers
      .get(root)!
      .slice()
      .sort((a, b) => globalRank.get(a)! - globalRank.get(b)! || cmpId(a, b));
    if (members.length < 2) return [];
    const id = `bundle:${members.join("+")}`;
    const span = bundleSpan.get(id);
    if (!span) return [];
    const baseSlot = slotAt.get(span.enterX)?.get(id) ?? 0;
    return [
      {
        id,
        threadIds: span.threadIds,
        enterX: span.enterX,
        exitX: span.exitX,
        baseSlot,
        collapsed: true,
      },
    ];
  });

  return {
    lanes,
    contentWidth: maxX,
    contentHeight: laneTop + (maxSlot + 1) * LANE_HEIGHT,
    convergences,
    connectors,
    bundles,
  };
}
