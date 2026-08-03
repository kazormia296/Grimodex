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
 * - startTime を持つイベントが一つでもあれば calendar モード（実時間軸）。
 *   日付未設定イベントは、日付設定済み範囲の後ろへ ordinal / id 順の proxy 日で置く。
 * - 全イベントが startTime を欠く場合だけ sequence モード
 *   （ordinal の序列ランクを日番号に流用）。
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

  const datedEvents = events.filter((event) => event.startTime != null);
  const hasCalendarAxis = datedEvents.length > 0;
  const byId = new Map<string, EffectiveDay>();

  if (hasCalendarAxis) {
    let dataStart = Infinity;
    let dataEnd = -Infinity;
    for (const e of datedEvents) {
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

    // 日付未設定イベントは実暦の距離を壊さず、実データ範囲の直後へ安定配置する。
    // proxy は描画専用であり、元イベントの startTime/endTime は変更しない。
    const undatedEvents = events
      .filter((event) => event.startTime == null)
      .sort(compareByOrdinalAndId);
    const datedDataEnd = dataEnd;
    undatedEvents.forEach((event, index) => {
      const proxyDay = datedDataEnd + index + 1;
      byId.set(event.id, { startDay: proxyDay, endDay: null });
      dataEnd = proxyDay;
    });

    return { byId, hasCalendarAxis: true, dataStart, dataEnd };
  }

  // sequence モード: ordinal の fractional-index 順、同点は id 文字列順で安定ソート。
  const sorted = [...events].sort(compareByOrdinalAndId);
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

function compareByOrdinalAndId(
  a: Pick<AxisEventInput, "id" | "ordinal">,
  b: Pick<AxisEventInput, "id" | "ordinal">,
): number {
  const ordinalOrder = cmpKeys(a.ordinal, b.ordinal);
  if (ordinalOrder !== 0) return ordinalOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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

/**
 * データ全域が収まり、左右にわずかな余白を持つ View を返す。
 * ただし全域が最小ズームでも収まらない（遠い外れ値でスパンが肥大した）場合は、
 * 左端の外れ値に張り付くと主要イベントが画面外へ押し出されるため、focusDay
 * （通常は開始日の中央値）を中心に据える。外れ値は pan で到達できる。
 */
export function fitAll(args: {
  dataStart: number;
  dataEnd: number;
  trackW: number;
  /** 収まりきらない時に中心に据える日（省略時は従来どおり左寄せ）。 */
  focusDay?: number;
}): View {
  const span = Math.max(args.dataEnd - args.dataStart, 30);
  const w = args.trackW > 0 ? args.trackW : 1;
  const raw = w / (span * 1.06);
  const pxPerDay = clampPxPerDay(raw);
  // pxPerDay > raw = 最小ズームへクランプされた（＝全域が入りきらない）。
  if (args.focusDay != null && pxPerDay > raw) {
    const visibleDays = w / pxPerDay;
    return { pxPerDay, viewStartDay: args.focusDay - visibleDays / 2 };
  }
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
