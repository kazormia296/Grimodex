import type { ChronicleLaneModel } from "./chronicleLaneModel";

export interface CausalEdgeGeom {
  causeId: string;
  effectId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 効果が原因より前（時系列矛盾）か。 */
  conflict: boolean;
}

/**
 * eventId → 描画位置(x,y) を返す純関数。x は親が射影した値(xById)、y はレーン中心。
 * 未割当行は contentHeight + laneHeight/2。x が無い event は除外。
 */
export function eventPositions(
  model: ChronicleLaneModel,
  xById: Map<string, number>,
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  for (const lane of model.lanes) {
    for (const m of lane.markers) {
      const x = xById.get(m.eventId);
      if (x !== undefined) pos.set(m.eventId, { x, y: lane.y });
    }
  }
  const unassignedY = model.contentHeight + model.laneHeight / 2;
  for (const m of model.unassigned) {
    const x = xById.get(m.eventId);
    if (x !== undefined) pos.set(m.eventId, { x, y: unassignedY });
  }
  return pos;
}

/**
 * 因果エッジ(原因→結果)の描画幾何を組む純関数。両端の位置が揃うものだけ。
 * conflict は `${causeId}|${effectId}` が conflictKeys に含まれるか。
 * 決定性: 順序は (causeId, effectId) 昇順。
 */
export function buildCausalEdges(
  relations: { causeId: string; effectId: string }[],
  positions: Map<string, { x: number; y: number }>,
  conflictKeys: Set<string>,
): CausalEdgeGeom[] {
  const edges: CausalEdgeGeom[] = [];
  for (const r of relations) {
    const a = positions.get(r.causeId);
    const b = positions.get(r.effectId);
    if (!a || !b) continue;
    edges.push({
      causeId: r.causeId,
      effectId: r.effectId,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      conflict: conflictKeys.has(`${r.causeId}|${r.effectId}`),
    });
  }
  edges.sort((p, q) =>
    p.causeId < q.causeId
      ? -1
      : p.causeId > q.causeId
        ? 1
        : p.effectId < q.effectId
          ? -1
          : p.effectId > q.effectId
            ? 1
            : 0,
  );
  return edges;
}
