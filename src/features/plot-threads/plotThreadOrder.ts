import { cmpKeys } from "@/features/tree/fractionalIndex";

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * center-out 行割り当て: rank 順(0=最重要)に中心 mid=(n-1)/2 から外へ交互配置した
 * 行 index を返す（`rows[rank]` = その rank のスレッドが座る行 index）。subway 自動整列の正本。
 */
export function centerOutRows(n: number): number[] {
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
 * 重要度（distinct 列数＝そのスレッドが触る distinct シーン数）降順 → sortOrder → id で
 * ランク付けした配列（先頭 = 最重要）。Timeline の subwaySort と同一の重要度ランク。
 */
export function rankThreadsBySubwayImportance<
  T extends { id: string; sortOrder: string },
>(threads: readonly T[], importanceOf: (id: string) => number): T[] {
  return [...threads].sort((a, b) => {
    const ia = importanceOf(a.id);
    const ib = importanceOf(b.id);
    if (ia !== ib) return ib - ia;
    const c = cmpKeys(a.sortOrder, b.sortOrder);
    return c !== 0 ? c : cmpId(a.id, b.id);
  });
}

/**
 * subway 自動整列の「視覚順」（Timeline の行 top→bottom / トラックの列 left→right）。
 * 重要度ランク → center-out 配置 → 行 index 昇順に並べ直す（＝最重要が中央に来る）。
 */
export function orderThreadsBySubwayImportance<
  T extends { id: string; sortOrder: string },
>(threads: readonly T[], importanceOf: (id: string) => number): T[] {
  const ranked = rankThreadsBySubwayImportance(threads, importanceOf);
  const rows = centerOutRows(ranked.length);
  return ranked
    .map((t, rank) => ({ t, row: rows[rank] }))
    .sort((a, b) => a.row - b.row)
    .map((x) => x.t);
}
