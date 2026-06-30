import { cmpKeys } from "@/features/tree/fractionalIndex";

/**
 * 作中年表（Chronicle）水平タイムラインの pan/zoom 変換と、
 * 「実効日（effective day）」割り当て・スクロールバー幾何を担う純粋関数群。
 *
 * - すべて副作用なし・決定的（Date.now / Math.random / I/O / React 不使用）。
 * - 日番号（day number）を横軸の論理座標とし、ピクセル座標との相互変換を行う。
 */

export interface AxisEventInput {
  id: string;
  ordinal: string;
  startTime: number | null;
  endTime: number | null;
  /** 時刻(0..1439)。日番号へ分数日として畳み込み、時刻を横軸に反映する。 */
  startMinute?: number | null;
  endMinute?: number | null;
}

const MINUTES_PER_DAY = 24 * 60;
/** 日番号＋時刻 → 分数日（time granularity を横軸位置へ反映）。 */
function foldMinute(day: number, minute: number | null | undefined): number {
  return day + (minute ?? 0) / MINUTES_PER_DAY;
}

export interface EffectiveDay {
  startDay: number;
  endDay: number | null;
}

export interface EffectiveDaysResult {
  byId: Map<string, EffectiveDay>;
  hasCalendarAxis: boolean;
  dataStart: number;
  dataEnd: number;
}

/**
 * 各イベントに実効日を割り当てる。
 *
 * - 全イベントが startTime を持つなら calendar モード（実時間軸）。
 * - 一つでも欠ければ sequence モード（ordinal の序列ランクを日番号に流用）。
 */
export function effectiveDays(events: AxisEventInput[]): EffectiveDaysResult {
  if (events.length === 0) {
    return {
      byId: new Map(),
      hasCalendarAxis: false,
      dataStart: 0,
      dataEnd: 0,
    };
  }

  const hasCalendarAxis = events.every((e) => e.startTime != null);
  const byId = new Map<string, EffectiveDay>();

  if (hasCalendarAxis) {
    let dataStart = Infinity;
    let dataEnd = -Infinity;
    for (const e of events) {
      const startDay = foldMinute(e.startTime as number, e.startMinute);
      const endDay =
        e.endTime != null
          ? Math.max(foldMinute(e.endTime, e.endMinute), startDay)
          : null;
      byId.set(e.id, { startDay, endDay });
      if (startDay < dataStart) dataStart = startDay;
      if (startDay > dataEnd) dataEnd = startDay;
      if (endDay != null) {
        if (endDay < dataStart) dataStart = endDay;
        if (endDay > dataEnd) dataEnd = endDay;
      }
    }
    return { byId, hasCalendarAxis: true, dataStart, dataEnd };
  }

  // sequence モード: ordinal の fractional-index 順、同点は id 文字列順で安定ソート。
  const sorted = [...events].sort((a, b) => {
    const c = cmpKeys(a.ordinal, b.ordinal);
    if (c !== 0) return c;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  sorted.forEach((e, index) => {
    byId.set(e.id, { startDay: index, endDay: null });
  });
  return {
    byId,
    hasCalendarAxis: false,
    dataStart: 0,
    dataEnd: Math.max(sorted.length - 1, 0),
  };
}

export interface View {
  pxPerDay: number;
  viewStartDay: number;
}

const MIN_PX_PER_DAY = 0.06;
const MAX_PX_PER_DAY = 130000;

/** pxPerDay を許容ズーム範囲にクランプする。 */
export function clampPxPerDay(p: number): number {
  return Math.max(MIN_PX_PER_DAY, Math.min(p, MAX_PX_PER_DAY));
}

/** データ全域が収まり、左右にわずかな余白を持つ View を返す。 */
export function fitAll(args: {
  dataStart: number;
  dataEnd: number;
  trackW: number;
}): View {
  const span = Math.max(args.dataEnd - args.dataStart, 30);
  const w = args.trackW > 0 ? args.trackW : 1;
  const pxPerDay = clampPxPerDay(w / (span * 1.06));
  const viewStartDay = args.dataStart - span * 0.03;
  return { pxPerDay, viewStartDay };
}

/** pivotPx の位置に映る日を固定したままズームする。 */
export function zoomAt(args: {
  view: View;
  pivotPx: number;
  factor: number;
}): View {
  const { view, pivotPx, factor } = args;
  const dayAt = view.viewStartDay + pivotPx / view.pxPerDay;
  const ppd = clampPxPerDay(view.pxPerDay * factor);
  return { pxPerDay: ppd, viewStartDay: dayAt - pivotPx / ppd };
}

/** トラック中央を pivot にしてズームする。 */
export function zoomByCenter(args: {
  view: View;
  trackW: number;
  factor: number;
}): View {
  return zoomAt({
    view: args.view,
    pivotPx: args.trackW / 2,
    factor: args.factor,
  });
}

/** ピクセル量だけ横スクロールする（dx>0 で内容が右へ流れる＝viewStart は減少）。 */
export function panByPx(args: { view: View; dx: number }): View {
  return {
    pxPerDay: args.view.pxPerDay,
    viewStartDay: args.view.viewStartDay - args.dx / args.view.pxPerDay,
  };
}

/** 日番号 → トラック内ピクセル X。 */
export function dayToX(view: View, day: number): number {
  return (day - view.viewStartDay) * view.pxPerDay;
}

/** トラック内ピクセル X → 日番号（pxPerDay 0 は viewStartDay にフォールバック）。 */
export function xToDay(view: View, x: number): number {
  if (view.pxPerDay === 0) return view.viewStartDay;
  return view.viewStartDay + x / view.pxPerDay;
}

export interface ScrollGeom {
  trackW: number;
  thumbW: number;
  thumbLeft: number;
  fullStart: number;
  denom: number;
}

/** スクロールバーのつまみ幅・位置と、つまみ↔viewStart 変換用の係数を算出する。 */
export function scrollGeom(args: {
  view: View;
  trackW: number;
  dataStart: number;
  dataEnd: number;
  padDays?: number;
}): ScrollGeom {
  const { view, trackW, dataStart, dataEnd } = args;
  const pad = args.padDays ?? 60;
  const fullStart = dataStart - pad;
  const fullEnd = dataEnd + pad;
  const fullDays = Math.max(fullEnd - fullStart, 1);
  const visibleDays = view.pxPerDay > 0 ? trackW / view.pxPerDay : fullDays;
  const thumbFrac = Math.max(0.04, Math.min(visibleDays / fullDays, 1));
  const thumbW = thumbFrac * trackW;
  const denom = Math.max(fullDays - visibleDays, 1e-6);
  const posFrac = Math.max(
    0,
    Math.min((view.viewStartDay - fullStart) / denom, 1),
  );
  const thumbLeft = posFrac * (trackW - thumbW);
  return { trackW, thumbW, thumbLeft, fullStart, denom };
}

/** つまみの左端ピクセル位置から viewStartDay を逆算する。 */
export function viewStartFromThumb(
  geom: ScrollGeom,
  thumbLeftPx: number,
): number {
  const room = geom.trackW - geom.thumbW;
  const frac = room <= 0 ? 0 : Math.max(0, Math.min(thumbLeftPx / room, 1));
  return geom.fullStart + frac * geom.denom;
}
