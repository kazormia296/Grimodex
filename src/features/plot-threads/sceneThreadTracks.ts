import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { PlotPhaseType } from "@/db/schema";
import type {
  PlotThreadRow,
  PlotThreadBranchRow,
  PlotThreadLinkRow,
} from "./api";
import { computeThreadRuns } from "./plotThreadRuns";
import { orderThreadsBySubwayImportance } from "./plotThreadOrder";

/** Phase 3a: スレッド上のマーカー 1 件（シーン id ＋ 段階）。 */
export interface SceneThreadMarker {
  nodeId: string;
  phaseType: PlotPhaseType;
}

/** Phase 3a: 現在シーンが 1 本の糸で持つ「位置づけ」と、同じ糸の他シーン。 */
export interface SceneThreadMembership {
  threadId: string;
  /** 現在シーンがこの糸で踏む段階（複数 link なら複数・出現順）。 */
  currentPhases: PlotPhaseType[];
  /** 同じ糸の他シーン（現在シーン除く・nodeId dedup・links 走査順）。 */
  others: SceneThreadMarker[];
}

/**
 * 指定シーンが属する各スレッドでの「位置づけ」と同じ糸の他シーンを返す純関数。
 * 意味検索でなく作者が明示した縦糸（thread リンク）の構造 lookup（Phase 3a）。
 * 本文は載せない＝AI 文脈には「縦糸の構成（タイトルと段階）」だけを渡す。
 * - 現在シーンの自リンクは currentPhases に集約（others からは除外）。
 * - others は nodeId で dedup（同シーンが複数段階を踏むなら最初の段階を採用）。
 * - スレッド順・others 順とも links 走査順で安定＝決定的。
 */
export function computeSceneThreadContext(
  links: PlotThreadLinkRow[],
  sceneId: string,
): SceneThreadMembership[] {
  // 1st pass: 現在シーンが属するスレッド（first-encounter 順）と currentPhases。
  const order: string[] = [];
  const byThread = new Map<string, SceneThreadMembership>();
  for (const l of links) {
    if (l.nodeId !== sceneId) continue;
    let m = byThread.get(l.threadId);
    if (!m) {
      m = { threadId: l.threadId, currentPhases: [], others: [] };
      byThread.set(l.threadId, m);
      order.push(l.threadId);
    }
    if (!m.currentPhases.includes(l.phaseType))
      m.currentPhases.push(l.phaseType);
  }
  if (order.length === 0) return [];
  // 2nd pass: 同じ糸の他シーン（nodeId dedup）。
  const seenOther = new Map<string, Set<string>>();
  for (const l of links) {
    const m = byThread.get(l.threadId);
    if (!m || l.nodeId === sceneId) continue;
    let seen = seenOther.get(l.threadId);
    if (!seen) {
      seen = new Set();
      seenOther.set(l.threadId, seen);
    }
    if (seen.has(l.nodeId)) continue;
    seen.add(l.nodeId);
    m.others.push({ nodeId: l.nodeId, phaseType: l.phaseType });
  }
  return order.map((id) => byThread.get(id)!);
}

/** スレッドトラック 1 列の幅(px)。各スレッドが 1 本の縦トラックを占める。 */
export const TRACK_COL_WIDTH = 11;

/**
 * 1 ノード × 1 列のセル状態（文字コード）。run（生存区間）内の (駅, 上半線, 下半線) を符号化。
 * - `.` 非アクティブ（線なし・run 外）
 * - `t` 先頭駅（駅＋下向き半線＝run 開始）
 * - `b` 末尾駅（駅＋上向き半線＝run 終了）
 * - `s` 中間駅（駅＋全高線）
 * - `|` 通過（全高線・駅なし＝run 内だがこの行に所属マーカー無し）
 * - `o` 単独駅（駅のみ・線なし＝長さ 1 の run）
 * - `T` 流入端（下向き半線・駅なし＝branch/merge の at 行から線が始まる）
 * - `B` 離脱端（上向き半線・駅なし＝branch/merge の at 行で線が終わる）
 */
export type TrackCellChar = "." | "t" | "b" | "s" | "|" | "o" | "T" | "B";

export interface SceneThreadTrackModel {
  /** 列＝可視範囲に所属シーンを持つスレッド（sortOrder 昇順）。 */
  columns: PlotThreadRow[];
  /** nodeId → 列順のセル状態文字列（length === columns.length）。
   *  文字列にすることで再計算後も内容不変なら Object.is 一致＝行 memo が保たれる。 */
  cellByNode: Record<string, string>;
  /** nodeId → その行の分岐/合流コネクタ列。`fromCol>toCol:kind`（kind=b|m）を
   *  カンマ区切りで符号化（文字列＝memo 安定）。両端スレッドが列に在るものだけ。 */
  connectorByNode: Record<string, string>;
}

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Scenes ツリーの「縦版ミニ・タイムライン」トラックモデルを生成する純関数。
 *
 * 各スレッドは固定の縦トラック（列）を持ち、所属シーン（マーカー）を駅、
 * 最初〜最後の所属シーン間を縦線で結ぶ（フォルダ等の非所属行も区間内なら通過線）。
 * 順序は描画される行の並び（orderedNodes）に従うため、列インデックス j が全行で
 * 同じ x に来る＝縦線が連続して見える（行ごとに自分のセルだけ描けば整列する）。
 *
 * 決定的: 乱数禁止。列順 = (sortOrder,id)。
 */
export function buildSceneThreadTracks(
  orderedNodes: { id: string }[],
  nodeThreadIds: Record<string, string[]>,
  threadsById: Map<string, PlotThreadRow>,
  branches: PlotThreadBranchRow[] = [],
  /** Timeline の「重要度順に整列」(plotSubwaySort) を列順に反映するか。
   *  true = 重要度(distinct 所属シーン数)＋center-out（Timeline の行と一致）/ false = sortOrder 線形。 */
  subwaySort = false,
): SceneThreadTrackModel {
  // 列 = 可視行のいずれかに所属するスレッド。memberCount = distinct 所属シーン数（＝重要度）。
  const memberThreadIds = new Set<string>();
  const memberCount = new Map<string, number>();
  for (const n of orderedNodes) {
    for (const tid of nodeThreadIds[n.id] ?? []) {
      memberThreadIds.add(tid);
      memberCount.set(tid, (memberCount.get(tid) ?? 0) + 1);
    }
  }
  const memberThreads = [...memberThreadIds]
    .map((id) => threadsById.get(id))
    .filter((t): t is PlotThreadRow => Boolean(t));
  const columns = subwaySort
    ? orderThreadsBySubwayImportance(
        memberThreads,
        (id) => memberCount.get(id) ?? 0,
      )
    : [...memberThreads].sort(
        (a, b) => cmpKeys(a.sortOrder, b.sortOrder) || cmpId(a.id, b.id),
      );

  if (columns.length === 0)
    return { columns, cellByNode: {}, connectorByNode: {} };

  const colIndex = new Map<string, number>();
  columns.forEach((c, j) => colIndex.set(c.id, j));

  // 行 index 解決。
  const rowOf = new Map<string, number>();
  orderedNodes.forEach((n, i) => rowOf.set(n.id, i));

  // 列スレッドのマーカー行（所属行）。
  const markerRows = new Map<string, Set<number>>();
  orderedNodes.forEach((n, i) => {
    for (const tid of nodeThreadIds[n.id] ?? []) {
      if (!colIndex.has(tid)) continue;
      const s = markerRows.get(tid);
      if (s) s.add(i);
      else markerRows.set(tid, new Set([i]));
    }
  });

  // 分岐/合流の離脱/流入/スパン行（両端が列・at 行が可視のものだけ）。Timeline と同契約:
  //  - merge の from は必ず離脱 / branch の from は「その行に自分のマーカーが無い」ときだけ離脱
  //  - to は at 行で流入 / from・to 双方の at 行で生存スパンを延ばす（コネクタが帯に接続する）
  const mergeFromRows = new Map<string, Set<number>>();
  const branchFromRows = new Map<string, Set<number>>();
  const enterRows = new Map<string, Set<number>>();
  const spanRows = new Map<string, number[]>();
  const addRow = (m: Map<string, Set<number>>, k: string, v: number) => {
    const s = m.get(k);
    if (s) s.add(v);
    else m.set(k, new Set([v]));
  };
  const addSpan = (k: string, v: number) => {
    const a = spanRows.get(k);
    if (a) a.push(v);
    else spanRows.set(k, [v]);
  };
  for (const b of branches) {
    if (!colIndex.has(b.fromThreadId) || !colIndex.has(b.toThreadId)) continue;
    if (b.fromThreadId === b.toThreadId) continue;
    const at = rowOf.get(b.atNodeId);
    if (at === undefined) continue;
    if (b.kind === "merge") addRow(mergeFromRows, b.fromThreadId, at);
    else addRow(branchFromRows, b.fromThreadId, at);
    addRow(enterRows, b.toThreadId, at);
    addSpan(b.fromThreadId, at);
    addSpan(b.toThreadId, at);
  }

  // 各列スレッドを run（Timeline と同一の生存区間）に分割し、行ごとのセル文字を確定する。
  const charByRowByCol = new Map<string, Map<number, string>>();
  for (const col of columns) {
    const marks = markerRows.get(col.id) ?? new Set<number>();
    const edges = spanRows.get(col.id) ?? [];
    const all = [...marks, ...edges];
    if (all.length === 0) continue;
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const leaveSet = new Set<number>();
    for (const c of mergeFromRows.get(col.id) ?? []) leaveSet.add(c);
    for (const c of branchFromRows.get(col.id) ?? []) {
      if (!marks.has(c)) leaveSet.add(c);
    }
    const enterSet = enterRows.get(col.id) ?? new Set<number>();
    const runs = computeThreadRuns(lo, hi, leaveSet, enterSet, marks);
    const charByRow = new Map<number, string>();
    for (const r of runs) {
      for (let i = r.start; i <= r.end; i++) {
        charByRow.set(i, encodeCell(marks.has(i), i > r.start, i < r.end));
      }
    }
    charByRowByCol.set(col.id, charByRow);
  }

  const cellByNode: Record<string, string> = {};
  orderedNodes.forEach((n, i) => {
    let s = "";
    for (const col of columns) {
      s += charByRowByCol.get(col.id)?.get(i) ?? ".";
    }
    cellByNode[n.id] = s;
  });

  // 分岐/合流コネクタ: at 行で from 列↔to 列を横リンク。両端が列に在るものだけ。
  const connectorByNode: Record<string, string> = {};
  for (const b of branches) {
    const f = colIndex.get(b.fromThreadId);
    const t = colIndex.get(b.toThreadId);
    if (f === undefined || t === undefined || f === t) continue;
    if (!rowOf.has(b.atNodeId)) continue;
    const kind = b.kind === "merge" ? "m" : "b";
    const enc = `${f}>${t}:${kind}`;
    connectorByNode[b.atNodeId] = connectorByNode[b.atNodeId]
      ? `${connectorByNode[b.atNodeId]},${enc}`
      : enc;
  }

  return { columns, cellByNode, connectorByNode };
}

/** (駅, 上半線, 下半線) → セル文字。 */
function encodeCell(station: boolean, up: boolean, down: boolean): string {
  if (station) {
    if (up && down) return "s";
    if (down) return "t";
    if (up) return "b";
    return "o";
  }
  if (up && down) return "|";
  if (down) return "T";
  if (up) return "B";
  return ".";
}
