/**
 * 年表の出来事の並び（CED/1 の K1）と、現在地との前後の判定（K2・K2a、DR-CED-5・6）。
 *
 * 裏の並び（ordinal）は、同じ日時の出来事の間の順にだけ使う。前後は日時の幅で決める。
 * 「今の場面」の印（今の場面に結び付いた出来事）は、この関数では扱わない
 * （CPL/1 が、呼び出す側で付ける）。純粋な関数だけ。
 */
import { cmpKeys } from "../tree/fractionalIndex.js";
import {
  type ChronicleAnchorSpanInput,
  type ChronicleEventSpanRow,
  type ChronicleSpan,
  anchorSpan,
  eventSpan,
} from "./chronicleSpan.js";
import type { ChronicleCalendar } from "./chronicleTime.js";
import type { EventRow } from "./eventRows.js";

/** 現在地から見た出来事の位置。これまで／同時進行／これから／不明。 */
export type ChronicleRelation = "before" | "concurrent" | "after" | "unknown";

/** 並べる・判定するのに要る欄。 */
export type ChronicleOrderRow = ChronicleEventSpanRow &
  Pick<EventRow, "id" | "ordinal">;

/**
 * 文字列を、コードユニット順（Rust の str の比較と同じ並び。ids は ASCII の前提）で比べる。
 * id の同点の決め方の正本。chronicleProvisionalDate.ts もこれを使う。
 */
export function cmpIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 幅の始まり（無ければ null）が同じときの、裏の並び → id の同点の決め方。 */
function tieBreak(a: ChronicleOrderRow, b: ChronicleOrderRow): number {
  return cmpKeys(a.ordinal, b.ordinal) || cmpIds(a.id, b.id);
}

/** 幅を出した後の比較（K1）。日時の無い出来事（null）は、全部の後ろ。 */
function compareBySpan(
  a: ChronicleOrderRow,
  spanA: ChronicleSpan | null,
  b: ChronicleOrderRow,
  spanB: ChronicleSpan | null,
): number {
  if (spanA && spanB) {
    if (spanA.start !== spanB.start) return spanA.start < spanB.start ? -1 : 1;
    return tieBreak(a, b);
  }
  if (spanA) return -1;
  if (spanB) return 1;
  return tieBreak(a, b);
}

/**
 * 2 つの出来事の比較関数（K1）。幅の始まり → 裏の並び（cmpKeys）→ id。
 * 日時の無い出来事は、日時のある出来事の全部の後ろで、その中は 裏の並び → id。
 * 月・季節・年だけの出来事は、保存された日ではなく、その幅の始まりで並ぶ。
 */
export function compareChronicleEvents(
  a: ChronicleOrderRow,
  b: ChronicleOrderRow,
  calendar: ChronicleCalendar | null,
): number {
  return compareBySpan(a, eventSpan(a, calendar), b, eventSpan(b, calendar));
}

/** K1 で並べた新しい配列を返す（入力は変えない。幅は 1 件 1 回だけ出す）。 */
export function sortChronicleEvents<T extends ChronicleOrderRow>(
  events: readonly T[],
  calendar: ChronicleCalendar | null,
): T[] {
  return events
    .map((event) => ({ event, span: eventSpan(event, calendar) }))
    .sort((x, y) => compareBySpan(x.event, x.span, y.event, y.span))
    .map((entry) => entry.event);
}

/**
 * 幅どうしの前後（K2）。どちらかが null（日時が無い）なら unknown。
 * 出来事の幅の全部が現在地より前なら before、全部が後なら after、重なれば concurrent。
 * 幅は終わりを含まないので、接する（出来事の終わり＝現在地の始まり、または逆）は重ならない（DR-CED-6）。
 * 現在地が、手前の場面から借りたもの（proxy）のときは、同時かどうかを決められないので、
 * 重なる出来事は before（K2a）。
 */
export function relationOfSpans(
  event: ChronicleSpan | null,
  anchor: ChronicleSpan | null,
  borrowed: boolean,
): ChronicleRelation {
  if (!event || !anchor) return "unknown";
  if (event.end <= anchor.start) return "before";
  if (event.start >= anchor.end) return "after";
  return borrowed ? "before" : "concurrent";
}

/**
 * 出来事と現在地から、「これまで／同時進行／これから／不明」を返す（K2・K2a）。
 * 現在地が決まらない（source が none）か、出来事に日時が無ければ unknown。
 */
export function classifyEventRelation(
  event: ChronicleEventSpanRow,
  anchor: ChronicleAnchorSpanInput,
  calendar: ChronicleCalendar | null,
): ChronicleRelation {
  return relationOfSpans(
    eventSpan(event, calendar),
    anchorSpan(anchor, calendar),
    anchor.source === "proxy",
  );
}
