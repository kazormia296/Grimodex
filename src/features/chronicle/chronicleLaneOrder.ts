import { getProjectSetting, setProjectSetting } from "@/features/settings/api";

/**
 * 作中年表の codex レーン表示順（per-project）。
 * chronicleStore はグローバル設定に保存するため per-project には使えない。
 * projectSettings（key-value, Drizzle 経由）に codexId 配列の JSON で永続化する。
 */
const LANE_ORDER_KEY = "chronicle.laneOrder";

/** 保存された並び順（codexId[]）を読む。未保存/壊れた値は []。 */
export async function loadLaneOrder(projectId: string): Promise<string[]> {
  try {
    const raw = await getProjectSetting(projectId, LANE_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}

/** 並び順（codexId[]）を保存する。 */
export async function saveLaneOrder(
  projectId: string,
  order: string[],
): Promise<void> {
  await setProjectSetting(projectId, LANE_ORDER_KEY, JSON.stringify(order));
}

/** order 配列を codexId→index の Map にする（比較の O(1) 化）。 */
export function orderIndexMap(order: string[]): Map<string, number> {
  const m = new Map<string, number>();
  order.forEach((id, i) => {
    if (!m.has(id)) m.set(id, i);
  });
  return m;
}

/**
 * codex レーンの比較: カスタム順(order)にある id を先に order 順で、
 * 無い id は name 昇順（同名は id）でフォールバック。決定性: 純関数。
 */
export function compareByLaneOrder(
  a: { id: string; name: string },
  b: { id: string; name: string },
  orderIndex: Map<string, number>,
): number {
  const ia = orderIndex.get(a.id);
  const ib = orderIndex.get(b.id);
  if (ia != null && ib != null) return ia - ib;
  if (ia != null) return -1;
  if (ib != null) return 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Grid 方式の順次入替え用: ポインタ Y が、並べ替え対象（active 除く）兄弟の
 * midpoint をいくつ越えたか＝挿入 index。midpoints は表示順の固定スナップショット。
 * 純関数（決定性・単調）。
 */
export function dropIndexByMidpoints(
  py: number,
  siblingMids: number[],
): number {
  let idx = 0;
  for (const mid of siblingMids) if (py > mid) idx++;
  return idx;
}

/**
 * 並べ替え結果のマージ。prev（全 codexId・旧順）の可視スロットを newOrder（可視の新順）で
 * 順に詰め直し、不可視だが存在する id は元の絶対位置を維持、存在しない（削除済み）id は捨てる。
 * prev に無い新規可視 id は後置。これで不可視 codex（出来事0 等）の位置を保ち、削除 id の
 * laneOrder 蓄積も防ぐ。決定性: 純関数。
 */
export function mergeLaneOrder(
  prev: string[],
  newOrder: string[],
  exists: (id: string) => boolean,
): string[] {
  const visible = new Set(newOrder);
  const merged: string[] = [];
  let vi = 0;
  for (const id of prev) {
    if (visible.has(id)) {
      if (vi < newOrder.length) merged.push(newOrder[vi++]); // 可視スロット
    } else if (exists(id)) {
      merged.push(id); // 不可視だが存在＝元位置を維持
    }
    // 存在しない（削除済み）不可視 id は捨てる
  }
  while (vi < newOrder.length) merged.push(newOrder[vi++]); // prev に無い新規可視
  return merged;
}

/**
 * order（全 codexId・表示順）から id を取り除き index 位置へ挿入した新順序。
 * index は [0, length-1] にクランプ。id が無ければ order をそのまま返す。
 */
export function moveToIndex(
  order: string[],
  id: string,
  index: number,
): string[] {
  if (!order.includes(id)) return order;
  const without = order.filter((x) => x !== id);
  const i = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, i), id, ...without.slice(i)];
}
