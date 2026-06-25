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

export function laneY(index: number): number {
  return LANE_TOP + index * LANE_HEIGHT;
}

export interface PlotLaneMarker {
  linkId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  /** シーン x インデックス（px 変換は viewport の xOf に委ねる）。 */
  x: number;
  /** その列でのスレッド Y（px）。出会い列では中心へ寄った値、それ以外はホーム行 Y。 */
  y: number;
}
/** スレッド線の連続セグメント。x はシーン index（xOf 変換）、y は px。
 *  ホーム行を走る区間は y1===y2（水平）。出会いへ寄る/戻る所は斜め。 */
export interface PlotLineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** この区間の右端が branch/merge の「離脱（ramp out）」列。true のとき viewport は
   *  右端を CONNECTOR_RAMP だけ手前で止め、ランプの始端へなめらかに渡す。 */
  rampOutEnd?: boolean;
}
export interface PlotLane {
  thread: PlotThreadRow;
  /** ホーム行 Y（左ガター・ラベル・背景線アンカー。線形状は端点で駆動）。 */
  y: number;
  markers: PlotLaneMarker[];
  /** 連続線セグメント（隣接列の連なり。merge/branch の継ぎ目で切れる）。 */
  lineSegments: PlotLineSegment[];
  /** 「完結」終端の x（線が自走で終わる＝最後のビートが merge でないとき）。 */
  terminusX: number | null;
  /** 生存列ごとの実 Y(px)。ホーム行 or 出会いで寄った値。 */
  yByColumn: Map<number, number>;
  /** 「抜けシーン」列: スレッドの生存 run 内でマーカーが無い列（branch/merge の
   *  離脱・流入列は除外）。線は通っているがビートが無い＝サブプロット休止列。昇順。 */
  gapCols: number[];
}
/** 分岐 / 合流のコネクタ。あるシーン x で fromY↔toY のレーン間を繋ぐ。
 *  fromY/toY は at 列の実 Y から取る（#5 = ホーム行固定値ではなく寄った後の Y）。 */
export interface PlotConnector {
  id: string;
  x: number;
  fromY: number;
  toY: number;
  kind: PlotBranchKind;
  color: string | null;
}
export interface PlotLaneModel {
  lanes: PlotLane[];
  /** 最大シーン index（px 変換は viewport 側）。 */
  contentWidth: number;
  contentHeight: number;
  /** 2 本以上のスレッドがマーカーを持つシーン x（昇順・出会い列）。 */
  convergences: number[];
  /** 分岐 / 合流コネクタ（from/to スレッドと at シーンが揃うものだけ）。 */
  connectors: PlotConnector[];
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

/** center-out 行割り当て: rank 順(0=最重要)に中心 mid=(n-1)/2 から外へ交互配置した
 *  行 index を返す（重要度ランク順に中央から外へ交互配置する自動整列用）。 */
function centerOutRows(n: number): number[] {
  const mid = (n - 1) / 2;
  return Array.from({ length: n }, (_, row) => row).sort((a, b) => {
    const da = Math.abs(a - mid);
    const db = Math.abs(b - mid);
    if (da !== db) return da - db;
    if (a !== b) return b - a;
    return 0;
  });
}

/**
 * プロットスレッドの「ストーリーライン図」レイアウト（Plottr 型）を生成する純関数。
 *
 * モデル: 各スレッドは sortOrder 順の **固定ホーム行** を真っ直ぐ走る（畳まない＝重ねない）。
 * 出会い（収束＝複数スレッドが同列にマーカー）は線を寄せず、convergences の淡い縦バンドで表す。
 *
 * 決定性: 乱数/Date.now 禁止。順序 = (sortOrder,id)。全比較子に id 最終タイブレーク。
 */
export function buildPlotLaneModel(args: {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  sceneX: Map<string, number>;
  laneTop?: number;
  branches?: PlotThreadBranchRow[];
  /** scheduled シーン数。これ以上の x（story-time の未配置）は描かない。既定 Infinity。 */
  scheduledCount?: number;
  /** ホーム行の割り当て方式。subway と同じ「重要度(distinct 列数)降順 → center-out」に
   *  する場合 true。既定 false = sortOrder の線形。 */
  subwaySort?: boolean;
  /** スレッドごとの Y(px) を外から上書きする。ドラッグ並べ替え／subway順トグルの
   *  アニメーションで、ホーム行の代わりに「いま表示すべき Y」を流し込むために使う。
   *  指定が無いスレッドはホーム行 Y にフォールバック。これは構造（セグメント/コネクタの
   *  有無・順序）には影響せず、垂直座標だけを動かす（homeY が全垂直位置の単一の源）。 */
  laneYByThread?: Map<string, number>;
}): PlotLaneModel {
  const {
    threads,
    links,
    sceneX,
    laneTop = LANE_TOP,
    branches = [],
    scheduledCount = Infinity,
    subwaySort = false,
    laneYByThread,
  } = args;

  // ───────── PREP: 順序・ホーム行 ─────────
  // 出力順（lanes 配列・ラベル列）の基準は常に sortOrder→id。ホーム行 Y の割り当てだけ
  // subwaySort で切り替える。
  const orderedThreads = [...threads].sort((a, b) => {
    const c = cmpKeys(a.sortOrder, b.sortOrder);
    return c !== 0 ? c : cmpId(a.id, b.id);
  });
  // ホーム行: 既定は sortOrder の線形。subwaySort のときは subway と同じ
  // 「重要度(distinct 列数)降順 → sortOrder → id」ランク＋center-out 行割り当て。
  let homeRow: Map<string, number>;
  if (subwaySort) {
    const colsByThread = new Map<string, Set<number>>();
    for (const l of links) {
      const x = sceneX.get(l.nodeId);
      if (x === undefined || x >= scheduledCount) continue;
      const s = colsByThread.get(l.threadId);
      if (s) s.add(x);
      else colsByThread.set(l.threadId, new Set([x]));
    }
    const importanceOf = (id: string) => colsByThread.get(id)?.size ?? 0;
    const ranked = [...threads].sort((a, b) => {
      const ia = importanceOf(a.id);
      const ib = importanceOf(b.id);
      if (ia !== ib) return ib - ia;
      const c = cmpKeys(a.sortOrder, b.sortOrder);
      return c !== 0 ? c : cmpId(a.id, b.id);
    });
    const rows = centerOutRows(ranked.length);
    homeRow = new Map(ranked.map((t, rank) => [t.id, rows[rank]]));
  } else {
    homeRow = new Map<string, number>(orderedThreads.map((t, i) => [t.id, i]));
  }
  const homeY = (threadId: string) =>
    laneYByThread?.get(threadId) ??
    laneTop + (homeRow.get(threadId) ?? 0) * LANE_HEIGHT;

  const linksByThread = new Map<string, PlotThreadLinkRow[]>();
  for (const l of links) {
    const arr = linksByThread.get(l.threadId);
    if (arr) arr.push(l);
    else linksByThread.set(l.threadId, [l]);
  }

  // 統一モデル: branch / merge は「線が from レーンから to レーンへ移る」遷移点。離脱は
  // 種別で非対称:
  //  - merge の from: 必ず離脱（to へ畳まれて消える）。band はランプ始端で終わる(rampOut)。
  //  - branch の from: その列より後ろに「自走マーカー」が有れば離脱せず連続（並列走行:
  //    分岐しても親線は走り続ける／branch 後の列にマーカーがあれば繋ぐ）。無ければ離脱。
  //  - to（再流入）: 不在中にこの列へ来たら新しい run（その列=マーカー位置）から始まる。
  // 「自走マーカー」= 再流入列(enterCols=to)でないマーカー列。他線のエッジで連れ戻された点
  // （別レーンへ渡って戻ってきた合流/分岐入り）は自走の続きではないので除外する。
  // span: at 列を from/to 双方の生存スパン候補に入れ、帯がランプ端へ届くようにする。
  const branchFromColsByThread = new Map<string, Set<number>>(); // branch の from
  const mergeFromColsByThread = new Map<string, Set<number>>(); // merge の from（必離脱）
  const enterColsByThread = new Map<string, Set<number>>(); // to（再流入列）
  const spanColsByThread = new Map<string, number[]>();
  const addCol = (m: Map<string, Set<number>>, k: string, v: number) => {
    const s = m.get(k);
    if (s) s.add(v);
    else m.set(k, new Set([v]));
  };
  const addSpanCol = (k: string, v: number) => {
    const a = spanColsByThread.get(k);
    if (a) a.push(v);
    else spanColsByThread.set(k, [v]);
  };
  for (const b of branches) {
    const x = sceneX.get(b.atNodeId);
    if (x === undefined || x >= scheduledCount) continue;
    if (b.kind === "merge") addCol(mergeFromColsByThread, b.fromThreadId, x);
    else addCol(branchFromColsByThread, b.fromThreadId, x);
    addCol(enterColsByThread, b.toThreadId, x);
    addSpanCol(b.fromThreadId, x);
    addSpanCol(b.toThreadId, x);
  }

  interface Prep {
    thread: PlotThreadRow;
    markers: PlotLaneMarker[]; // y は後で埋める
    markerCols: Set<number>; // マーカーを持つ列（出会い判定用）
    lo: number; // 生存スパン開始列
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
    const markerCols = new Set(markers.map((m) => m.x));

    // 生存スパン = [firstMarkerX, lastMarkerX]。branch/merge の at 列も候補に含める
    // （from/to 双方を生存させ、コネクタの両端が帯に接続するようにする）。
    const firstMarkerX = markers.length ? markers[0].x : undefined;
    const lastMarkerX = markers.length
      ? markers[markers.length - 1].x
      : undefined;
    const edgeCols = spanColsByThread.get(thread.id) ?? [];
    const loCands = [firstMarkerX, ...edgeCols].filter(
      (v): v is number => v !== undefined,
    );
    const hiCands = [lastMarkerX, ...edgeCols].filter(
      (v): v is number => v !== undefined,
    );
    let lo = loCands.length ? Math.min(...loCands) : undefined;
    let hi = hiCands.length ? Math.max(...hiCands) : undefined;
    if (lo === undefined) lo = hi;
    if (hi === undefined) hi = lo;
    const living = lo !== undefined;
    if (living && (hi as number) < (lo as number)) hi = lo;
    if (living && (hi as number) > maxX) maxX = hi as number;

    return {
      thread,
      markers,
      markerCols,
      lo: lo ?? 0,
      hi: hi ?? 0,
      living,
    };
  });

  // ───────── 収束（出会い列）: ≥2 レーンがマーカーを持つ列 ─────────
  const threadsWithMarkerAt = new Map<number, string[]>();
  for (const p of preps) {
    for (const x of p.markerCols) {
      const arr = threadsWithMarkerAt.get(x);
      if (arr) arr.push(p.thread.id);
      else threadsWithMarkerAt.set(x, [p.thread.id]);
    }
  }
  const convergences = [...threadsWithMarkerAt.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([x]) => x)
    .sort((a, b) => a - b);

  // ───────── 列ごとの実 Y(px): 各スレッドは固定ホーム行を真っ直ぐ走る ─────────
  // （出会いで寄せる挙動はユーザー指定で無し。収束は convergences の淡い縦バンドのみで表す）。
  const yByColumnByThread = new Map<string, Map<number, number>>();
  for (const p of preps) {
    if (!p.living) continue;
    const m = new Map<number, number>();
    const y = homeY(p.thread.id);
    for (let c = p.lo; c <= p.hi; c++) m.set(c, y);
    yByColumnByThread.set(p.thread.id, m);
  }

  // ───────── 出力: レーン ─────────
  const lanes: PlotLane[] = preps.map((p) => {
    const thread = p.thread;
    const yHome = homeY(thread.id);
    if (!p.living) {
      return {
        thread,
        y: yHome,
        markers: [],
        lineSegments: [],
        terminusX: null,
        yByColumn: new Map(),
        gapCols: [],
      };
    }
    const yByColumn = yByColumnByThread.get(thread.id)!;
    const markers = p.markers.map((mk) => ({
      ...mk,
      y: yByColumn.get(mk.x) ?? yHome,
    }));

    // 離脱列(leaveCols)を確定する。
    //  - merge の from は必ず離脱（to へ畳まれて消える）。
    //  - branch の from は「その列に自分のマーカーが無い」ときだけ離脱（線が別レーンへ渡って
    //    自分はそこに居ない）。自分のマーカーが有る列では離脱せず連続（自分の beat があるので
    //    本線はそのまま走り、ランプは分岐として脇へ出るだけ）。
    const branchFromCols = branchFromColsByThread.get(thread.id);
    const mergeFromCols = mergeFromColsByThread.get(thread.id);
    const enterCols = enterColsByThread.get(thread.id);
    const leaveCols = new Set<number>();
    if (mergeFromCols) for (const c of mergeFromCols) leaveCols.add(c);
    if (branchFromCols) {
      for (const c of branchFromCols) {
        if (!p.markerCols.has(c)) leaveCols.add(c);
      }
    }

    // run 分割（統一遷移モデル）: スレッドは lo で誕生し、離脱列で band が切れて不在になり、
    // 流入列(enter=to)やマーカー列で再び現れる。離脱→次の流入の間（別レーンを走っている
    // 区間）は band を空ける＝連続させない。各 run は homeY 水平 1 本。
    const runs: Array<{ start: number; end: number; rampOutEnd: boolean }> = [];
    let active = true; // lo で誕生
    let start = p.lo;
    for (let c = p.lo; c <= p.hi; c++) {
      if (active && leaveCols.has(c)) {
        // 離脱: band はこの列で終わり、ランプの始端へ渡す。
        runs.push({ start, end: c, rampOutEnd: true });
        active = false;
      } else if (!active && (enterCols?.has(c) || p.markerCols.has(c))) {
        // 流入 / マーカー再出現: この列（マーカー位置）から新しい run。
        start = c;
        active = true;
        // 同一列で流入かつ即離脱（その場で別レーンへ渡る）なら 1 列 run。
        if (leaveCols.has(c)) {
          runs.push({ start, end: c, rampOutEnd: true });
          active = false;
        }
      }
    }
    if (active) runs.push({ start, end: p.hi, rampOutEnd: false });

    // 固定ホーム行モデルでは run 内の y は一定なので、各 run = homeY 水平 1 セグメント。
    const lineSegments: PlotLineSegment[] = [];
    for (const r of runs) {
      if (r.end === r.start) continue; // 単一列 run は点（マーカー / コネクタで表す）
      lineSegments.push(
        r.rampOutEnd
          ? { x1: r.start, y1: yHome, x2: r.end, y2: yHome, rampOutEnd: true }
          : { x1: r.start, y1: yHome, x2: r.end, y2: yHome },
      );
    }

    // 終端キャップ: 最後の run が「離脱でなく」「長さを持ち」「実在の終端」（=マーカー列）
    // で終わるなら付ける。離脱(rampOut)や span 延長だけの列には付けない（別レーンへ渡る点
    // ／分岐点で線がいきなり完結したように見えるのを防ぐ）。
    const lastRun = runs[runs.length - 1];
    const isRealEnd = lastRun !== undefined && p.markerCols.has(lastRun.end);
    const terminusX =
      lastRun && lastRun.end > lastRun.start && !lastRun.rampOutEnd && isRealEnd
        ? lastRun.end
        : null;

    // 抜けシーン列: 各 run（=線が実際に走る生存区間）内で、マーカーが無く、かつ
    // branch/merge の流入(enter)・離脱(leave)でもない列。別レーンへ渡っている空白
    // 区間は run 自体に含まれないため自動的に除外される（生存判定と一本化）。
    const gapCols: number[] = [];
    for (const r of runs) {
      for (let c = r.start; c <= r.end; c++) {
        if (p.markerCols.has(c)) continue;
        if (enterCols?.has(c)) continue;
        if (leaveCols.has(c)) continue;
        gapCols.push(c);
      }
    }

    return {
      thread,
      y: yHome,
      markers,
      lineSegments,
      terminusX,
      yByColumn,
      gapCols,
    };
  });
  const laneByThread = new Map(lanes.map((l) => [l.thread.id, l]));

  // ───────── 分岐 / 合流コネクタ（fromY/toY は at 列の実 Y）─────────
  const orderedBranches = [...branches].sort((a, b) => cmpId(a.id, b.id));
  const connectors: PlotConnector[] = orderedBranches.flatMap((b) => {
    const from = laneByThread.get(b.fromThreadId);
    const to = laneByThread.get(b.toThreadId);
    const x = sceneX.get(b.atNodeId);
    if (!from || !to || x === undefined || x >= scheduledCount) return [];
    const fromY = from.yByColumn.get(x) ?? from.y;
    const toY = to.yByColumn.get(x) ?? to.y;
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

  return {
    lanes,
    contentWidth: maxX,
    contentHeight: laneTop + orderedThreads.length * LANE_HEIGHT,
    convergences,
    connectors,
  };
}

/**
 * ヘッダー縦ドラッグ並べ替え中の「各スレッドが向かうべき Y(px)」を算出する純関数。
 * ドラッグ点はカーソル Y へ即時追従、それ以外の行はドロップ位置に挿し込んだとき
 * 隙間を埋めるよう 1 段ぶん退避する。buildPlotLaneModel の laneYByThread 上書きへ流す。
 *
 * 決定性: 乱数/時刻なし。order は表示行順（index = 行）で渡すこと。
 */
export function computeLaneDragTargets(params: {
  /** 表示行順（index が行番号）。homeY は各スレッドのホーム行 Y(px)。 */
  order: { id: string; homeY: number }[];
  draggedId: string;
  currentY: number;
  /** 先頭行の Y(px)（= threadsTop）。 */
  laneTop: number;
  laneHeight: number;
}): Map<string, number> {
  const { order, draggedId, currentY, laneTop, laneHeight } = params;
  const n = order.length;
  const out = new Map<string, number>();
  const dragIndex = order.findIndex((o) => o.id === draggedId);
  if (dragIndex < 0 || n === 0) {
    for (const o of order) out.set(o.id, o.homeY);
    return out;
  }
  const targetRow = Math.max(
    0,
    Math.min(n - 1, Math.round((currentY - laneTop) / laneHeight)),
  );
  order.forEach((o, i) => {
    if (i === dragIndex) {
      out.set(o.id, currentY); // ドラッグ点はカーソル追従
      return;
    }
    let shift = 0;
    if (dragIndex < targetRow && i > dragIndex && i <= targetRow) shift = -1;
    else if (dragIndex > targetRow && i >= targetRow && i < dragIndex)
      shift = 1;
    out.set(o.id, o.homeY + shift * laneHeight);
  });
  return out;
}
