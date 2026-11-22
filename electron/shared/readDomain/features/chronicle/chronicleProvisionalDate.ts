/**
 * 日時の無い出来事に入れる、仮の日時の決め方（CED/1 の I2、判断の記録 DR-CED-8）。
 *
 * 「最も後の日」は、保存された日付そのものから決める（月・季節・年の幅の終わりは使わない）。
 *  - 日時のある出来事の、開始の日と、終わりの日（終わりの粒度が none でないもの）。
 *  - 保管済みでない場面の作中日付。
 * 日時の無い出来事を、その翌日から 1 日ずつ置く。置く順は、裏の並び（ordinal）→ 作った日時 →
 * id（決定 14）。出来事にも場面にも日付が無ければ、暦の起点の日（日数 0）から。
 *
 * 日時の無い出来事（仮の日時を入れる対象）は、開始の日が無い出来事である。
 * 開始の日があって粒度が none の出来事は、I3 が、同じ移行の中で粒度を直す対象なので、
 * 仮の日時は入れない。直した後は日時のある出来事なので、その日は「最も後の日」に数える。
 * 粒度が知らない文字列で、開始の日がある出来事も、対象にせず（I4：想定しない値は飛ばす）、
 * その日だけを「最も後の日」に数える。
 *
 * 純粋な関数だけ。DOM・Node・DB・store・React を使わない。
 */
import { instantEpochMilliseconds } from "../../lib/time.js";
import { cmpKeys } from "../tree/fractionalIndex.js";
import { cmpIds } from "./chronicleOrder.js";
import { hasChronicleDate } from "./chronicleSpan.js";
import type { EventRow } from "./eventRows.js";

/** 仮の日時を決めるのに要る出来事の欄。粒度は、知らない文字列も受ける。 */
export type ChronicleProvisionalEventRow = Pick<
  EventRow,
  "id" | "ordinal" | "createdAt" | "startTime" | "endTime"
> & {
  startGranularity: string;
  endGranularity: string;
};

/** 保管済みでない場面の作中日付（日時の有無の判定に要る欄だけ）。 */
export interface ChronicleProvisionalSceneDate {
  startTime: number | null;
  startGranularity: string;
}

/** 仮の日時を入れる出来事と、入れる日（日数）。 */
export interface ChronicleProvisionalDate {
  id: string;
  startTime: number;
}

function isDay(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 日時の無い出来事（仮の日時を入れる対象）か。開始の日が無い出来事。
 * 終わりだけが残っている出来事も、対象（終わりは I3 が消す）。
 */
function needsProvisionalDate(row: ChronicleProvisionalEventRow): boolean {
  return !isDay(row.startTime);
}

/**
 * 「最も後の日」の翌日（日数）。日付が 1 つも無ければ 0（暦の起点の日）。
 * 日は切り捨てる（保存される日は整数）。
 */
export function provisionalBaseDay(
  events: readonly ChronicleProvisionalEventRow[],
  liveSceneDates: readonly ChronicleProvisionalSceneDate[],
): number {
  let latest = Number.NEGATIVE_INFINITY;
  const take = (day: number) => {
    const d = Math.floor(day);
    if (d > latest) latest = d;
  };
  for (const e of events) {
    if (!isDay(e.startTime)) continue;
    take(e.startTime);
    if (
      isDay(e.endTime) &&
      hasChronicleDate({
        startTime: e.endTime,
        startMinute: null,
        startGranularity: e.endGranularity,
      })
    ) {
      take(e.endTime);
    }
  }
  for (const s of liveSceneDates) {
    if (
      hasChronicleDate({
        startTime: s.startTime,
        startMinute: null,
        startGranularity: s.startGranularity,
      })
    ) {
      take(s.startTime as number);
    }
  }
  return Number.isFinite(latest) ? latest + 1 : 0;
}

/**
 * 作った日時を、時刻として比べる（DR-CED-12）。ミリ秒まで。
 * 読める値どうしは、時刻の順。読めない値は、読める値の後ろ。
 * 両方とも読めないときは、同じとして扱い、次の鍵（id）に渡す。
 * 文字列としては比べない（実行環境の並びの規則に、結果を左右させない。Native と同じ結果にする）。
 */
function compareCreatedAt(a: string, b: string): number {
  const left = instantEpochMilliseconds(a);
  const right = instantEpochMilliseconds(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return Math.sign(left - right);
}

/**
 * 日時の無い出来事の id と、入れる日（日数）の対応を、置く順に返す（I2）。
 * 置く順は、裏の並び → 作った日時 → id（DR-CED-12）。
 */
export function provisionalEventDates(
  events: readonly ChronicleProvisionalEventRow[],
  liveSceneDates: readonly ChronicleProvisionalSceneDate[],
): ChronicleProvisionalDate[] {
  const base = provisionalBaseDay(events, liveSceneDates);
  return events
    .filter(needsProvisionalDate)
    .sort(
      (a, b) =>
        cmpKeys(a.ordinal, b.ordinal) ||
        compareCreatedAt(a.createdAt, b.createdAt) ||
        cmpIds(a.id, b.id),
    )
    .map((e, i) => ({ id: e.id, startTime: base + i }));
}
