import type { EventRow } from "./api";

/** 1 日の分数（作中時刻は 0..1439 分で保持）。 */
export const MIN_PER_DAY = 1440;

/**
 * 端数を含む day 値を、現在のルーラー粒度に応じて day/分へ分解する。
 * subDay=true(hour/minute ズーム)は整数日＋分へ、false はそのまま日へ丸め分は保持。
 * 決定性: 乱数/時刻なしの純関数。
 */
export function splitDayMinute(
  fracDay: number,
  subDay: boolean,
  keepMinute: number | null,
): { time: number; minute: number | null } {
  if (subDay) {
    // Round the complete timestamp before splitting it. Rounding only the
    // fractional remainder can produce minute=1440 near the next-day boundary.
    const absoluteMinute = Math.round(fracDay * MIN_PER_DAY);
    const time = Math.floor(absoluteMinute / MIN_PER_DAY);
    return {
      time,
      minute: absoluteMinute - time * MIN_PER_DAY,
    };
  }
  return { time: Math.round(fracDay), minute: keepMinute };
}

/** Compare persisted Chronicle endpoints in their canonical absolute-minute domain. */
export function chronicleAbsoluteMinute(
  time: number,
  minute: number | null,
): number {
  return time * MIN_PER_DAY + (minute ?? 0);
}

/** 平行移動できる出来事の時刻フィールド（開始/終了の day・分）。 */
export interface ShiftableEvent {
  startTime: number;
  startMinute: number | null;
  endTime: number | null;
  endMinute: number | null;
}

/**
 * 1 出来事を deltaDays(端数可) 平行移動した patch（開始/終了・期間長を保持）。
 * subDay=false(日グリッド以上)は差分を整数日へ丸めて一律移動する（分端数による相対ズレを
 * 防ぐため。分は不変）。subDay=true(hour/minute)は端数を分へ反映して移動する。
 * 決定性: 純関数。
 */
export function shiftEventPatch(
  e: ShiftableEvent,
  deltaDays: number,
  subDay: boolean,
): Partial<EventRow> {
  const dDay = subDay ? deltaDays : Math.round(deltaDays);
  const patch: Partial<EventRow> = {};
  if (!subDay) {
    patch.startTime = e.startTime + dDay;
    if (e.endTime != null) patch.endTime = e.endTime + dDay;
    return patch;
  }
  const ss = splitDayMinute(
    e.startTime + (e.startMinute ?? 0) / MIN_PER_DAY + dDay,
    true,
    e.startMinute,
  );
  patch.startTime = ss.time;
  patch.startMinute = ss.minute;
  patch.startGranularity = "time";
  if (e.endTime != null) {
    const es = splitDayMinute(
      e.endTime + (e.endMinute ?? 0) / MIN_PER_DAY + dDay,
      true,
      e.endMinute,
    );
    patch.endTime = es.time;
    patch.endMinute = es.minute;
    patch.endGranularity = "time";
  }
  return patch;
}

/**
 * 単独マーカーの先端を newStartDay へ置く patch。
 *
 * 日グリッド以上では従来どおり開始日を吸着先へ置き、開始・終了の分は保持する。
 * hour/minute グリッドでは実効開始時刻との差分を期間両端へ同量適用し、分を含む
 * 期間長を変えない。
 */
export function moveEventToDayPatch(
  e: ShiftableEvent,
  newStartDay: number,
  subDay: boolean,
): Partial<EventRow> {
  if (subDay) {
    const currentStartDay = e.startTime + (e.startMinute ?? 0) / MIN_PER_DAY;
    return shiftEventPatch(e, newStartDay - currentStartDay, true);
  }

  const start = splitDayMinute(newStartDay, false, e.startMinute);
  const patch: Partial<EventRow> = { startTime: start.time };
  if (e.endTime != null) {
    patch.endTime = start.time + (e.endTime - e.startTime);
  }
  return patch;
}

/**
 * Resize one interval endpoint while preserving start <= end at minute
 * precision. Day-level gestures retain the endpoint's persisted minute; a
 * crossing gesture clamps the changed endpoint to the opposite endpoint as
 * one atomic day/minute patch.
 */
export function resizeEventEndpointPatch(
  e: ShiftableEvent,
  edge: "start" | "end",
  newDay: number,
  subDay: boolean,
): Partial<EventRow> {
  if (edge === "start") {
    let next = splitDayMinute(newDay, subDay, e.startMinute);
    if (
      e.endTime != null &&
      chronicleAbsoluteMinute(next.time, next.minute) >
        chronicleAbsoluteMinute(e.endTime, e.endMinute)
    ) {
      next = {
        time: e.endTime,
        // A sub-day resize (or an already timed start) must remain a complete
        // time tuple even when the opposite endpoint is coarse. Its canonical
        // boundary is that day's 00:00, not `time + minute=null`.
        minute: e.endMinute ?? (subDay || e.startMinute != null ? 0 : null),
      };
    }
    return {
      startTime: next.time,
      ...(subDay || next.minute !== e.startMinute
        ? { startMinute: next.minute }
        : {}),
      ...(subDay || (e.startMinute == null && next.minute != null)
        ? { startGranularity: "time" as const }
        : {}),
    };
  }

  let next = splitDayMinute(newDay, subDay, e.endMinute);
  if (
    chronicleAbsoluteMinute(next.time, next.minute) <
    chronicleAbsoluteMinute(e.startTime, e.startMinute)
  ) {
    next = {
      time: e.startTime,
      minute: e.startMinute ?? (subDay || e.endMinute != null ? 0 : null),
    };
  }
  return {
    endTime: next.time,
    ...(subDay || next.minute !== e.endMinute
      ? { endMinute: next.minute }
      : {}),
    ...(subDay || (e.endMinute == null && next.minute != null)
      ? { endGranularity: "time" as const }
      : {}),
  };
}
