import { cmpKeys } from "@/features/tree/fractionalIndex";
import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";
import type { PlotThreadRow, PlotThreadLinkRow } from "./api";
import { LANE_TOP, LANE_HEIGHT } from "./plotThreadLaneModel";

/**
 * AeonTimeline 風「Subway View」レイアウトを生成する純関数。
 *
 * モデル（実機調査 + 設計 judge panel で確定）:
 * - イベント(シーン) = ノード(駅)、プロットスレッド = トラック(路線)。
 * - 各イベントは画面に **1 ノードだけ** 表示し、複数トラックが共有するノードの周りで
 *   路線が合流・分岐する（Separated レイアウトはトラックごとにノードを複製する別物）。
 * - トラックは「重要度（イベント数 = distinct 列数）」が高いほど中央寄りの行に、
 *   低いほど外側の行に **自動配置**（center-out）。交差を減らし視線を中央へ集める。
 * - ノード表現: 単一トラックのみ = 小さい塗りつぶし円 / 複数トラック = 大きい白抜き円。
 *
 * 重要な実装契約:
 * - 点列の x は **実在する整数 columnIndex のみ**。非線形タイムライン(weights)時の
 *   xOf は weights[i] の配列ルックアップで、小数 i を渡すと NaN を生む。ホーム行から
 *   斜めに入る/出る「スタブ」は描画側が px 空間で付与する（このモデルは整数列のみ返す）。
 * - 角丸 SVG パスは {@link roundedPath} で生成（点列は描画側で xOf により px 化してから渡す）。
 *
 * 決定性: 乱数 / Date.now 禁止。全ソートに id 最終タイブレーク。
 */

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

/** ノード(駅)に集まる 1 トラックぶんのマーカー。tooltip / インスペクタ用。 */
export interface SubwayNodeMarker {
  threadId: string;
  linkId: string;
  phaseType: PlotPhaseType;
}

/** 駅。1 シーン = 1 ノード。multi で白抜き/塗りを切替える。 */
export interface SubwayNode {
  nodeId: string;
  /** シーン列 index（px 変換は描画側 xOf）。 */
  x: number;
  /** ホスト行の Y(px)。所属トラックのうち最重要(rank 最小)1 本の行。 */
  y: number;
  /** 所属トラック id（rank 昇順 → id 昇順、先頭 = host）。 */
  trackIds: string[];
  multi: boolean;
  /** host トラックの色。 */
  color: string | null;
  hostThreadId: string;
  /** 所属トラックのマーカー（rank → phase → linkId 昇順）。 */
  markers: SubwayNodeMarker[];
}

/** 路線。points は整数列 index の頂点列（描画側で px 化 + スタブ付与）。 */
export interface SubwayTrack {
  thread: PlotThreadRow;
  threadId: string;
  rowIndex: number;
  homeY: number;
  color: string | null;
  /** イベント数（= distinct 列数）。0 ならホーム行ラベルのみ。 */
  importance: number;
  /** ルーティング済み頂点列。x = columnIndex(整数), y = px。空なら線を描かない。
   *  anchor=true は「ホーム行への進入/退出アンカー」（描画側がここだけ px スタブで斜入させる）。
   *  anchor=false は実在の駅頂点（スタブを付けてはならない＝駅と線が分離する）。 */
  points: { x: number; y: number; anchor: boolean }[];
}

export interface PlotSubwayModel {
  /** rowIndex 昇順。 */
  tracks: SubwayTrack[];
  /** x 昇順 → y 昇順 → nodeId 昇順。 */
  nodes: SubwayNode[];
  /** 最大シーン列 index。 */
  contentWidth: number;
  contentHeight: number;
  rowCount: number;
}

/**
 * center-out 行割り当て: 全 row index(0..n-1) を中心 mid=(n-1)/2 からの距離で
 * 安定ソートし、rank 順に割り当てる（半整数キー比較を避ける = 偶数本でも決定的）。
 * rows[rank] = その rank(0=最重要) を置く行 index。
 */
export function centerOutRows(n: number): number[] {
  const mid = (n - 1) / 2;
  return Array.from({ length: n }, (_, row) => row).sort((a, b) => {
    const da = Math.abs(a - mid);
    const db = Math.abs(b - mid);
    if (da !== db) return da - db; // 中心に近い行を先に
    if (a !== b) return b - a; // 同距離は下(大きい row)優先で固定タイブレーク
    return 0;
  });
}

/**
 * 点列を角丸 SVG パスへ。各内部コーナーを半径 radius で丸める（隣接 2 セグメント長の
 * 半分にクランプ）。水平/斜め/垂直の混在に一般ベクトルで対応。共線コーナーは直線で通す。
 *
 * 前提: points の x,y は同単位(px)。x=列 index のままだと半径が x/y で非等方になるため、
 * 呼び出し側で xOf により px 化してから渡すこと。
 *
 * 決定性: 出力数値は fmt() で 3 桁丸め + -0 正規化しスナップショット安定。
 */
export function roundedPath(
  points: { x: number; y: number }[],
  radius: number,
): string {
  // 連続重複点を除去（ゼロ長セグメント排除）。
  const p: { x: number; y: number }[] = [];
  for (const q of points) {
    const last = p[p.length - 1];
    if (!last || last.x !== q.x || last.y !== q.y) p.push({ x: q.x, y: q.y });
  }
  if (p.length === 0) return "";
  if (p.length === 1) return `M ${fmt(p[0].x)} ${fmt(p[0].y)}`;
  if (p.length === 2) {
    return `M ${fmt(p[0].x)} ${fmt(p[0].y)} L ${fmt(p[1].x)} ${fmt(p[1].y)}`;
  }

  const lenOf = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(b.x - a.x, b.y - a.y);
  const along = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    d: number,
  ): { x: number; y: number } => {
    const L = lenOf(a, b);
    if (L === 0) return { x: a.x, y: a.y };
    const t = d / L;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };

  let out = `M ${fmt(p[0].x)} ${fmt(p[0].y)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const prev = p[i - 1];
    const cur = p[i];
    const next = p[i + 1];

    const lenIn = lenOf(prev, cur);
    const lenOut = lenOf(cur, next);
    if (lenIn === 0 || lenOut === 0) {
      out += ` L ${fmt(cur.x)} ${fmt(cur.y)}`;
      continue;
    }

    // 共線(外積 0)なら丸めず直線。
    const cross =
      (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (cross === 0) {
      out += ` L ${fmt(cur.x)} ${fmt(cur.y)}`;
      continue;
    }

    const r = Math.min(radius, lenIn / 2, lenOut / 2);
    if (r <= 0) {
      out += ` L ${fmt(cur.x)} ${fmt(cur.y)}`;
      continue;
    }

    const inP = along(cur, prev, r);
    const outP = along(cur, next, r);
    out += ` L ${fmt(inP.x)} ${fmt(inP.y)}`;
    out += ` Q ${fmt(cur.x)} ${fmt(cur.y)} ${fmt(outP.x)} ${fmt(outP.y)}`;
  }

  const e = p[p.length - 1];
  out += ` L ${fmt(e.x)} ${fmt(e.y)}`;
  return out;
}

/** 決定的・桁安定な数値整形（浮動小数のテキスト揺れ防止 + -0 正規化）。 */
function fmt(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

interface ValidLink {
  linkId: string;
  threadId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  x: number;
}

export function buildPlotSubwayModel(args: {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  sceneX: Map<string, number>;
  laneTop?: number;
  /** scheduled シーン数。これ以上の x（story-time の未配置）は描かない。既定 Infinity。 */
  scheduledCount?: number;
}): PlotSubwayModel {
  const {
    threads,
    links,
    sceneX,
    laneTop = LANE_TOP,
    scheduledCount = Infinity,
  } = args;

  const threadById = new Map(threads.map((t) => [t.id, t]));
  const n = threads.length;

  // ───────── valid links（既知トラック・scheduled 内・列解決可能のみ） ─────────
  let maxX = 0;
  const validLinks: ValidLink[] = [];
  for (const l of links) {
    if (!threadById.has(l.threadId)) continue;
    const x = sceneX.get(l.nodeId);
    if (x === undefined || x >= scheduledCount) continue;
    if (x > maxX) maxX = x;
    validLinks.push({
      linkId: l.id,
      threadId: l.threadId,
      nodeId: l.nodeId,
      phaseType: l.phaseType,
      x,
    });
  }

  // ───────── 重要度 = distinct 列数 ─────────
  const colsByThread = new Map<string, Set<number>>();
  for (const v of validLinks) {
    const s = colsByThread.get(v.threadId);
    if (s) s.add(v.x);
    else colsByThread.set(v.threadId, new Set([v.x]));
  }
  const importanceOf = (id: string) => colsByThread.get(id)?.size ?? 0;

  // ───────── rank（重要度降順 → sortOrder → id） ─────────
  const rankedThreads = [...threads].sort((a, b) => {
    const ia = importanceOf(a.id);
    const ib = importanceOf(b.id);
    if (ia !== ib) return ib - ia;
    const c = cmpKeys(a.sortOrder, b.sortOrder);
    return c !== 0 ? c : cmpId(a.id, b.id);
  });
  const rankByThread = new Map(rankedThreads.map((t, i) => [t.id, i]));

  // ───────── center-out 行 → homeY ─────────
  const rows = centerOutRows(n);
  const rowByThread = new Map<string, number>();
  rankedThreads.forEach((t, rank) => rowByThread.set(t.id, rows[rank]));
  const homeY = (id: string) =>
    laneTop + (rowByThread.get(id) ?? 0) * LANE_HEIGHT;

  // ───────── ノード（nodeId 単位。1 シーン = 1 駅） ─────────
  const linksByNode = new Map<string, ValidLink[]>();
  for (const v of validLinks) {
    const arr = linksByNode.get(v.nodeId);
    if (arr) arr.push(v);
    else linksByNode.set(v.nodeId, [v]);
  }
  const cmpRank = (a: string, b: string) => {
    const ra = rankByThread.get(a) ?? 0;
    const rb = rankByThread.get(b) ?? 0;
    return ra !== rb ? ra - rb : cmpId(a, b);
  };
  const nodes: SubwayNode[] = [...linksByNode.entries()].map(([nodeId, ls]) => {
    const trackIds = [...new Set(ls.map((l) => l.threadId))].sort(cmpRank);
    const hostThreadId = trackIds[0];
    const x = ls[0].x;
    const markers = [...ls]
      .sort((a, b) => {
        const r = cmpRank(a.threadId, b.threadId);
        if (r !== 0) return r;
        const p =
          (PHASE_ORDER[a.phaseType] ?? 0) - (PHASE_ORDER[b.phaseType] ?? 0);
        return p !== 0 ? p : cmpId(a.linkId, b.linkId);
      })
      .map((l) => ({
        threadId: l.threadId,
        linkId: l.linkId,
        phaseType: l.phaseType,
      }));
    return {
      nodeId,
      x,
      y: homeY(hostThreadId),
      trackIds,
      multi: trackIds.length >= 2,
      color: threadById.get(hostThreadId)?.color ?? null,
      hostThreadId,
      markers,
    };
  });
  nodes.sort((a, b) => {
    if (a.x !== b.x) return a.x - b.x;
    if (a.y !== b.y) return a.y - b.y;
    return cmpId(a.nodeId, b.nodeId);
  });

  // 列 → その列の各ノード（nodeId 昇順）。トラックの目標 Y 解決に使う。
  const nodesByCol = new Map<number, SubwayNode[]>();
  for (const nd of nodes) {
    const arr = nodesByCol.get(nd.x);
    if (arr) arr.push(nd);
    else nodesByCol.set(nd.x, [nd]);
  }
  for (const arr of nodesByCol.values()) {
    arr.sort((a, b) => cmpId(a.nodeId, b.nodeId));
  }

  // ───────── トラック（路線ルーティング） ─────────
  const tracks: SubwayTrack[] = rankedThreads
    .map((thread) => {
      const hy = homeY(thread.id);
      const cols = colsByThread.get(thread.id);
      const evCols = cols ? [...cols].sort((a, b) => a - b) : [];

      // 各列の目標 Y: その列で thread を含むノード（nodeId 昇順先頭）の y。
      const targetY = (c: number): number => {
        const arr = nodesByCol.get(c);
        if (arr) {
          for (const nd of arr) {
            if (nd.trackIds.includes(thread.id)) return nd.y;
          }
        }
        return hy;
      };

      const points: { x: number; y: number; anchor: boolean }[] = [];
      const push = (x: number, y: number, anchor: boolean) => {
        const p = points[points.length - 1];
        if (!p || p.x !== x || p.y !== y) points.push({ x, y, anchor });
      };
      if (evCols.length > 0) {
        const allHome = evCols.every((c) => targetY(c) === hy);
        // 単独・全ホーム・1 駅のみ → 線不要（駅のみ）。
        if (!(evCols.length === 1 && allHome)) {
          const first = evCols[0];
          const last = evCols[evCols.length - 1];
          // 進入アンカー（先頭駅が別行なら first 列の homeY）。px ずらしは描画側。
          if (targetY(first) !== hy) push(first, hy, true);
          for (const c of evCols) push(c, targetY(c), false);
          // 退出アンカー（末尾駅が別行なら last 列の homeY）。
          if (targetY(last) !== hy) push(last, hy, true);
        }
      }

      return {
        thread,
        threadId: thread.id,
        rowIndex: rowByThread.get(thread.id) ?? 0,
        homeY: hy,
        color: thread.color,
        importance: importanceOf(thread.id),
        points,
      };
    })
    .sort((a, b) => a.rowIndex - b.rowIndex);

  return {
    tracks,
    nodes,
    contentWidth: maxX,
    contentHeight: laneTop + n * LANE_HEIGHT,
    rowCount: n,
  };
}
