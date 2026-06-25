import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { PlotThreadRow, PlotThreadBranchRow } from "./api";

/** スレッドトラック 1 列の幅(px)。各スレッドが 1 本の縦トラックを占める。 */
export const TRACK_COL_WIDTH = 11;

/**
 * 1 ノード × 1 列のセル状態（文字コード）。
 * - `.` 非アクティブ（線なし）
 * - `t` 先頭駅（駅＋下向き半線）
 * - `b` 末尾駅（駅＋上向き半線）
 * - `s` 中間駅（駅＋全高線）
 * - `|` 通過（線のみ＝そのスレッドの区間内だが、このシーンには所属マーカー無し）
 * - `o` 単独駅（駅のみ・線なし＝そのスレッドが 1 シーンだけ）
 */
export type TrackCellChar = "." | "t" | "b" | "s" | "|" | "o";

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
): SceneThreadTrackModel {
  // 列 = 可視行のいずれかに所属するスレッド
  const memberThreadIds = new Set<string>();
  for (const n of orderedNodes) {
    for (const tid of nodeThreadIds[n.id] ?? []) memberThreadIds.add(tid);
  }
  const columns = [...memberThreadIds]
    .map((id) => threadsById.get(id))
    .filter((t): t is PlotThreadRow => Boolean(t))
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder) || cmpId(a.id, b.id));

  if (columns.length === 0)
    return { columns, cellByNode: {}, connectorByNode: {} };

  // 各列スレッドの先頭/末尾の所属行 index（可視順）
  const firstIdx = new Map<string, number>();
  const lastIdx = new Map<string, number>();
  orderedNodes.forEach((n, i) => {
    for (const tid of nodeThreadIds[n.id] ?? []) {
      if (!firstIdx.has(tid)) firstIdx.set(tid, i);
      lastIdx.set(tid, i);
    }
  });

  const cellByNode: Record<string, string> = {};
  orderedNodes.forEach((n, i) => {
    const members = new Set(nodeThreadIds[n.id] ?? []);
    let s = "";
    for (const col of columns) {
      const f = firstIdx.get(col.id)!;
      const l = lastIdx.get(col.id)!;
      if (i < f || i > l) {
        s += ".";
      } else if (f === l) {
        s += "o"; // 単独駅
      } else if (i === f) {
        s += "t";
      } else if (i === l) {
        s += "b";
      } else {
        s += members.has(col.id) ? "s" : "|";
      }
    }
    cellByNode[n.id] = s;
  });

  // 分岐/合流コネクタ: at 列の行で from 列↔to 列を横リンク。両端が列に在るものだけ。
  const colIndex = new Map<string, number>();
  columns.forEach((c, j) => colIndex.set(c.id, j));
  const nodeIds = new Set(orderedNodes.map((n) => n.id));
  const connectorByNode: Record<string, string> = {};
  for (const b of branches) {
    const f = colIndex.get(b.fromThreadId);
    const t = colIndex.get(b.toThreadId);
    if (f === undefined || t === undefined || f === t) continue;
    if (!nodeIds.has(b.atNodeId)) continue;
    const kind = b.kind === "merge" ? "m" : "b";
    const enc = `${f}>${t}:${kind}`;
    connectorByNode[b.atNodeId] = connectorByNode[b.atNodeId]
      ? `${connectorByNode[b.atNodeId]},${enc}`
      : enc;
  }

  return { columns, cellByNode, connectorByNode };
}
