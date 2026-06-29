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

/** ポインタ Y が対象セルの下半分にあるか（true=後ろへ挿入）。純関数。 */
export function dropAfter(
  clientY: number,
  rect: { top: number; height: number },
): boolean {
  return clientY > rect.top + rect.height / 2;
}

/**
 * draggedId を targetId の前/後へ移動した新しい順序を返す。
 * targetId=null は末尾へ。draggedId が無ければ current をそのまま。
 * 注意: 渡す current は「現在可視の codex 順」のスナップショット。可視外（出来事0
 * 等）の codex は含まれないため、呼び出し側で既存 laneOrder とマージして保存する。
 */
export function reorderLaneOrder(
  current: string[],
  draggedId: string,
  targetId: string | null,
  after: boolean,
): string[] {
  if (!current.includes(draggedId)) return current;
  const without = current.filter((id) => id !== draggedId);
  if (targetId == null || targetId === draggedId) {
    return [...without, draggedId];
  }
  const ti = without.indexOf(targetId);
  if (ti === -1) return [...without, draggedId];
  const insertAt = after ? ti + 1 : ti;
  return [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
}
