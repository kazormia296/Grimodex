export type LaneKind = "character" | "location" | "unassigned" | string;

export interface PackEventInput {
  id: string;
  startX: number;
  isInterval: boolean;
  barWidth: number | null;
  estWidth: number;
}

export interface PackLaneInput {
  codexId: string | null;
  name: string;
  kind: LaneKind;
  unassigned: boolean;
  events: PackEventInput[];
  /** 出来事が無くてもレーンを残す（ピン留めした空レーン）。 */
  keepEmpty?: boolean;
  /** ピン留めレーンの識別キー（割当/解除用）。 */
  pinKey?: string;
}

export interface PackSpacing {
  laneVPad: number;
  tokenH: number;
  rowGap: number;
}

export interface PackedMarker {
  eventId: string;
  left: number;
  row: number;
  cy: number;
}

export interface PackedLane {
  codexId: string | null;
  name: string;
  kind: LaneKind;
  unassigned: boolean;
  count: number;
  top: number;
  height: number;
  rows: number;
  markers: PackedMarker[];
  /** ピン留めした空レーンか（出来事 0 でも表示）。 */
  keepEmpty: boolean;
  /** ピン留めレーンの識別キー。 */
  pinKey?: string;
}

export interface LanePackResult {
  lanes: PackedLane[];
  totalHeight: number;
  centers: Map<string, { cx: number; cy: number }>;
  laneSepTops: number[];
}

interface PlacedEvent {
  ev: PackEventInput;
  left: number;
  row: number;
}

/**
 * y(px) が属するレーンを返す（pack の top..top+height 範囲）。範囲外は最近傍へ
 * クランプ（上端より上=先頭、下端より下=末尾）。レーンが無ければ null。
 * ドラッグでのレーン跨ぎ再割当に使う。決定性: 純関数。
 */
export function laneAtY(lanes: PackedLane[], y: number): PackedLane | null {
  if (lanes.length === 0) return null;
  for (const lane of lanes) {
    if (y >= lane.top && y < lane.top + lane.height) return lane;
  }
  if (y < lanes[0].top) return lanes[0];
  // 最終レーンより下＝レーン外（未割当領域）。グラフエリアはここまで有効。
  return null;
}

export function packLanes(args: {
  lanes: PackLaneInput[];
  spacing: PackSpacing;
  gap?: number;
}): LanePackResult {
  const gap = args.gap ?? 8;
  const { spacing } = args;

  const lanes: PackedLane[] = [];
  const centers = new Map<string, { cx: number; cy: number }>();
  const laneSepTops: number[] = [];

  let top = 0;

  for (const lane of args.lanes) {
    // 出来事 0 のレーンは通常スキップするが、ピン留め(keepEmpty)は空でも残す。
    if (lane.events.length === 0 && !lane.keepEmpty) continue;

    const sorted = [...lane.events].sort((a, b) => {
      if (a.startX !== b.startX) return a.startX - b.startX;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const rowEnds: number[] = [];
    const placed: PlacedEvent[] = [];

    for (const ev of sorted) {
      const left = ev.startX - (ev.isInterval ? 0 : 9);
      const wEst = ev.estWidth;
      let row = rowEnds.findIndex((end) => left - gap >= end);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(0);
      }
      rowEnds[row] = left + wEst;
      placed.push({ ev, left, row });
    }

    const rows = Math.max(1, rowEnds.length);
    const height =
      spacing.laneVPad * 2 +
      rows * spacing.tokenH +
      (rows - 1) * spacing.rowGap;

    laneSepTops.push(top);

    const markers: PackedMarker[] = [];
    for (const p of placed) {
      const cy =
        top +
        spacing.laneVPad +
        p.row * (spacing.tokenH + spacing.rowGap) +
        spacing.tokenH / 2;
      markers.push({ eventId: p.ev.id, left: p.left, row: p.row, cy });
      centers.set(p.ev.id, { cx: p.ev.startX, cy });
    }

    lanes.push({
      codexId: lane.codexId,
      name: lane.name,
      kind: lane.kind,
      unassigned: lane.unassigned,
      count: lane.events.length,
      top,
      height,
      rows,
      markers,
      keepEmpty: lane.keepEmpty ?? false,
      pinKey: lane.pinKey,
    });

    top += height;
  }

  const totalHeight = Math.max(top, 80);

  return { lanes, totalHeight, centers, laneSepTops };
}
