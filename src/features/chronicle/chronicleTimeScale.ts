import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { EventPrecision } from "@/db/schema";

export interface ScaleInputEvent {
  id: string;
  ordinal: string;
  startTime: number | null;
  endTime: number | null;
}

export interface ScaleParams {
  /** ビューポートの利用可能幅(px)。 */
  width: number;
  /** 左右パディング(px)。 */
  padX: number;
  /** ズーム倍率(1=フィット)。 */
  zoom: number;
  /** 横スクロール量(px)。 */
  scrollOffset: number;
}

export interface ScaledPoint {
  eventId: string;
  /** 開始 x(px)。 */
  x: number;
  /** interval 終端 x(px)。point もしくは rank モードでは null。 */
  xEnd: number | null;
}

/**
 * 出来事を作中時間軸の x(px) へ射影する純関数。
 * - 全 event に startTime があれば「時刻比例」配置（連続間隔・interval 幅を出す）。
 * - そうでなければ ordinal 等間隔（rank）配置（暦が無い時の honest な表現・interval は点）。
 * 決定性: 乱数/時刻なし。並びは cmpKeys(ordinal)。
 */
export function scaleEvents(
  events: ScaleInputEvent[],
  params: ScaleParams,
): ScaledPoint[] {
  const { width, padX, zoom, scrollOffset } = params;
  // ordinal 昇順で並べる。等しい ordinal は id で安定タイブレーク
  // （handlePull はシーンの storyTimeOrder をそのまま複製するため重複しうる）。
  const sorted = [...events].sort(
    (a, b) =>
      cmpKeys(a.ordinal, b.ordinal) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const n = sorted.length;
  if (n === 0) return [];
  const inner = Math.max(1, width - 2 * padX) * zoom;
  const px = (frac: number) => padX + frac * inner - scrollOffset;

  const haveAllTimes = sorted.every((e) => e.startTime != null);
  if (haveAllTimes) {
    // 真の時間レンジを全 time（startTime + 非 null の endTime）から求める。
    // ordinal 順 != 時系列順（フラッシュバック）や末尾 interval の超過があっても、
    // 全 x / xEnd が [padX, padX+inner] に収まることを保証する。
    // 大配列でも安全なよう Math.min(...spread) ではなくループで畳む。
    let t0 = sorted[0].startTime as number;
    let t1 = t0;
    for (const e of sorted) {
      const s = e.startTime as number;
      if (s < t0) t0 = s;
      if (s > t1) t1 = s;
      if (e.endTime != null) {
        if (e.endTime < t0) t0 = e.endTime;
        if (e.endTime > t1) t1 = e.endTime;
      }
    }
    const span = t1 - t0 || 1;
    return sorted.map((e) => ({
      eventId: e.id,
      x: px(((e.startTime as number) - t0) / span),
      xEnd: e.endTime != null ? px(((e.endTime as number) - t0) / span) : null,
    }));
  }

  // rank（ordinal 等間隔）。inner を n-1 等分。単一は padX。
  const step = n > 1 ? inner / (n - 1) : 0;
  return sorted.map((e, i) => ({
    eventId: e.id,
    x: padX + i * step - scrollOffset,
    xEnd: null,
  }));
}

export interface PrecisionStyle {
  opacity: number;
  dashed: boolean;
}

/** precision → 描画スタイル（exact=確定/approx=ぼかし/unknown=破線・薄い）。 */
export function precisionStyle(precision: EventPrecision): PrecisionStyle {
  switch (precision) {
    case "approx":
      return { opacity: 0.6, dashed: false };
    case "unknown":
      return { opacity: 0.4, dashed: true };
    case "exact":
    default:
      return { opacity: 1, dashed: false };
  }
}
