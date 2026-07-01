/**
 * 因果グラフ（cause → effect の有向辺）の走査ヘルパー。
 * - connectedCausalChain: ホバー時ハイライト用。ある出来事の**祖先(全世代・上方向のみ)**と
 *   **子孫(全世代・下方向のみ)**の和集合。方向を切り替えないので、途中で分岐しても兄弟の
 *   サブツリー（上方向で見つけた祖先の別 effect 等）は含めない。
 * - directCauses/directEffects: コンテキスト「原因/結果を選択」用。1 世代だけ（複数可）。
 */
export interface CausalEdge {
  causeId: string;
  effectId: string;
}

function buildMaps(relations: CausalEdge[]): {
  forward: Map<string, string[]>; // cause → effects
  reverse: Map<string, string[]>; // effect → causes
} {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const r of relations) {
    const f = forward.get(r.causeId);
    if (f) f.push(r.effectId);
    else forward.set(r.causeId, [r.effectId]);
    const b = reverse.get(r.effectId);
    if (b) b.push(r.causeId);
    else reverse.set(r.effectId, [r.causeId]);
  }
  return { forward, reverse };
}

/** start から map の向きにたどれる全ノード（start は含まない）。循環に強い。 */
function reachable(start: string, map: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(map.get(start) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur) || cur === start) continue;
    seen.add(cur);
    for (const next of map.get(cur) ?? []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

/** ホバー中の出来事に連なる因果チェーン（自分＋全祖先＋全子孫）。 */
export function connectedCausalChain(
  id: string,
  relations: CausalEdge[],
): Set<string> {
  const { forward, reverse } = buildMaps(relations);
  const result = new Set<string>([id]);
  for (const d of reachable(id, forward)) result.add(d); // 子孫（下方向のみ）
  for (const a of reachable(id, reverse)) result.add(a); // 祖先（上方向のみ）
  return result;
}

/** 直接の原因（1 世代上、複数可）。 */
export function directCauses(id: string, relations: CausalEdge[]): string[] {
  return relations.filter((r) => r.effectId === id).map((r) => r.causeId);
}

/** 直接の結果（1 世代下、複数可）。 */
export function directEffects(id: string, relations: CausalEdge[]): string[] {
  return relations.filter((r) => r.causeId === id).map((r) => r.effectId);
}
