export interface CausalRel {
  causeId: string;
  effectId: string;
}

export interface BezierEdge {
  causeId: string;
  effectId: string;
  d: string;
  arrowPoints: string;
  conflict: boolean;
}

const relKey = (rel: CausalRel): string => `${rel.causeId}|${rel.effectId}`;

export function buildCausalBezier(args: {
  relations: CausalRel[];
  /** outX=原因マーカー末尾（出力アンカー）。未指定なら cx にフォールバック。 */
  centers: Map<string, { cx: number; cy: number; outX?: number }>;
  conflictPairs: Set<string>;
}): BezierEdge[] {
  const result: BezierEdge[] = [];
  const sorted = [...args.relations].sort((p, q) =>
    relKey(p) < relKey(q) ? -1 : relKey(p) > relKey(q) ? 1 : 0,
  );
  for (const rel of sorted) {
    const a = args.centers.get(rel.causeId);
    const b = args.centers.get(rel.effectId);
    if (!a || !b) continue;
    // 出力(原因側)は末尾 outX から、入力(結果側)は従来どおり先頭 cx へ。
    const ax = a.outX ?? a.cx;
    const ay = a.cy;
    const dx = b.cx - ax;
    const c1x = ax + dx * 0.42;
    const c1y = ay + (b.cy - ay) * 0.14;
    const c2x = b.cx - dx * 0.42;
    const c2y = b.cy - (b.cy - ay) * 0.14;
    const conflict = args.conflictPairs.has(`${rel.causeId}|${rel.effectId}`);
    const d = `M ${ax} ${ay} C ${c1x} ${c1y} ${c2x} ${c2y} ${b.cx} ${b.cy}`;
    const tx = b.cx - c2x;
    const ty = b.cy - c2y;
    const L = Math.hypot(tx, ty) || 1;
    const ux = tx / L;
    const uy = ty / L;
    const back = 9;
    const aw = 4.6;
    const bx = b.cx - ux * back;
    const by = b.cy - uy * back;
    const px = -uy;
    const py = ux;
    const arrowPoints = `${b.cx},${b.cy} ${bx + px * aw},${by + py * aw} ${bx - px * aw},${by - py * aw}`;
    result.push({
      causeId: rel.causeId,
      effectId: rel.effectId,
      d,
      arrowPoints,
      conflict,
    });
  }
  return result;
}
