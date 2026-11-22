/**
 * 場面の「作中の現在地」を、日時で決める（CED/1 の C3・C3a・C4、判断の記録 DR-CED-7）。
 *
 * 今の resolveSceneAnchor は、結び付いた出来事のうち裏の並び（ordinal）が最も後のものを選ぶ。
 * こちらは、K1 の並び（幅の始まり → 裏の並び → id）で最も後のものを選ぶ。
 *
 * 現在地の決め方（C4）：
 *  1. 場面に作中日付があれば、その日付（source=scene）。
 *  2. 無ければ、その場面に結び付いた「材料にできる出来事」のうち、K1 で最も後のもの（source=stamped）。
 *  3. それも無ければ、読む順で手前の、現在地を持つ最も近い場面から借りる（source=proxy）。
 *     候補は「作中日付のある場面か、材料にできる出来事が結び付いた場面」に絞ってから選ぶ。
 *     最も近い場面が材料にできない出来事しか持たないときは、さらに手前の場面まで戻る。
 *     後ろの場面からは借りない。今の場面が読む順に無ければ借りない。
 *  4. どれも無ければ決まらない（source=none）。
 *
 * 材料にできる出来事（C3）は、日時があり、確度が「不明」でない出来事。
 * C3a：作品の出来事が全部「不明」（日時の無い出来事は B1 により「不明」として扱う）で、
 * 作中日付のある場面（保管済みを除く）も無いときに限り、確度が「不明」の出来事も材料にする。
 * 日時の無い出来事は、C3a でも材料にならない。
 *
 * 呼び出す側の責任：秘密の印の判定を先に掛けた出来事を渡す。保管済みの場面は
 * sceneChronicle・sceneEvents から除いて渡す。
 * C3a の「作品の出来事が全部」は、この関数では、渡された出来事だけで判定する。
 * 秘密の印で除く前の全部を渡すか、除いた後を渡すかは、切り替えの PR（§5 の 5）で、
 * 渡す集合とあわせて決める（DR-CED-14）。
 *
 * 純粋な関数だけ。DOM・Node・DB・store・React を使わない。
 */
import type { EventPrecision } from "../../db/schema.js";
import {
  type ChronicleOrderRow,
  compareChronicleEvents,
} from "./chronicleOrder.js";
import { cmpKeys } from "../tree/fractionalIndex.js";
import { hasChronicleDate } from "./chronicleSpan.js";
import type { ChronicleCalendar } from "./chronicleTime.js";
import type { SceneEventRow } from "./eventRows.js";
import type { ChronicleAnchor, SceneChronicle } from "./resolveSceneAnchor.js";

/** 現在地を決めるのに要る出来事の欄（並びに要る欄と、確度）。 */
export type ChronicleAnchorEventRow = ChronicleOrderRow & {
  precision: EventPrecision;
};

export interface ChronicleAnchorByDateContext {
  sceneEvents: SceneEventRow[];
  events: ChronicleAnchorEventRow[];
  /** computeGlobalSceneOrder(nodes) と同じ。場面 id → 読む順の番号。 */
  readingOrder: Map<string, number>;
  /** 場面 id → 場面自身の作中日付。保管済みの場面は除いて渡す。 */
  sceneChronicle?: Map<string, SceneChronicle>;
  /** 暦。null なら、月・季節・年は保存された日の 1 日の幅になる。 */
  calendar: ChronicleCalendar | null;
  /**
   * 作中日付のある、保管済みでない場面があるか（C3a の判定）。
   * 省略すると、sceneChronicle に日時のある場面があるかで決める。
   */
  hasDatedLiveScene?: boolean;
}

/** 現在地と、それを決めた出来事の id（scene・none では null）。 */
export interface ChronicleAnchorResolution {
  anchor: ChronicleAnchor;
  eventId: string | null;
}

/** 場面が作中日付を持つか。粒度が知らない文字列の場面は、日付が無いものとして扱う（DR-CED-3）。 */
function sceneHasDate(sc: SceneChronicle | undefined): sc is SceneChronicle {
  return (
    !!sc &&
    hasChronicleDate({
      startTime: sc.startTime,
      startMinute: sc.startMinute,
      startGranularity: sc.startGranularity,
    })
  );
}

const NONE_ANCHOR: ChronicleAnchor = {
  ordinal: "",
  startTime: null,
  startMinute: null,
  startGranularity: "none",
  precision: null,
  source: "none",
};

/**
 * 現在地と、それを決めた出来事の id を返す。
 * anchor の ordinal の欄は、今の型を保つために埋める（stamped・proxy は選んだ出来事の ordinal、
 * scene は今の syntheticOrdinal と同じ決め方）。新しい判定は、この欄を使わない。
 */
export function resolveChronicleAnchorByDate(
  sceneId: string,
  ctx: ChronicleAnchorByDateContext,
): ChronicleAnchorResolution {
  const { sceneEvents, events, readingOrder, sceneChronicle, calendar } = ctx;
  const eventById = new Map(events.map((e) => [e.id, e] as const));

  // C3a：出来事が全部「不明」（日時の無い出来事も「不明」として扱う）で、
  // 作中日付のある場面も無いとき。
  const datedLiveScene =
    ctx.hasDatedLiveScene ??
    (sceneChronicle
      ? [...sceneChronicle.values()].some((sc) => sceneHasDate(sc))
      : false);
  const allUnknown = events.every(
    (e) => !hasChronicleDate(e) || e.precision === "unknown",
  );
  const unknownIsMaterial = allUnknown && !datedLiveScene;

  const isMaterial = (e: ChronicleAnchorEventRow): boolean =>
    hasChronicleDate(e) && (e.precision !== "unknown" || unknownIsMaterial);

  // 場面 id → 結び付いた、材料にできる出来事（events に実在するものだけ。孤児の結び付きは無視）。
  const materialByScene = new Map<string, ChronicleAnchorEventRow[]>();
  for (const se of sceneEvents) {
    const ev = eventById.get(se.eventId);
    if (!ev || !isMaterial(ev)) continue;
    const arr = materialByScene.get(se.sceneId);
    if (arr) arr.push(ev);
    else materialByScene.set(se.sceneId, [ev]);
  }

  /** K1 で最も後の出来事（同点は 裏の並び → id の大きい方）。 */
  const latestEvent = (
    evs: ChronicleAnchorEventRow[],
  ): ChronicleAnchorEventRow =>
    evs.reduce((best, e) =>
      compareChronicleEvents(e, best, calendar) > 0 ? e : best,
    );

  /**
   * 時刻 t における「synthetic ordinal」：日時があり、startTime <= t の出来事のうち、
   * startTime が最大（同点は ordinal 最大）のものの ordinal。無ければ ""。
   * 今の resolveSceneAnchor の決め方に近いが、材料の出来事が違う。今は startTime のある出来事を
   * 全部数えるが、こちらは日時のある出来事（DR-CED-3）だけを数える。粒度が none や知らない文字列で、
   * 開始の日がある出来事は数えない。型を保つための欄で、新しい判定は使わない。
   */
  const syntheticOrdinal = (t: number): string => {
    let best: ChronicleAnchorEventRow | null = null;
    for (const e of events) {
      if (!hasChronicleDate(e)) continue;
      const st = e.startTime as number;
      if (st > t) continue;
      if (
        best == null ||
        st > (best.startTime as number) ||
        (st === best.startTime && cmpKeys(e.ordinal, best.ordinal) > 0)
      ) {
        best = e;
      }
    }
    return best ? best.ordinal : "";
  };

  /** 場面の直接の現在地（作中日付 → 材料にできる出来事）。無ければ null。 */
  const directAnchor = (sid: string): ChronicleAnchorResolution | null => {
    const sc = sceneChronicle?.get(sid);
    if (sceneHasDate(sc)) {
      return {
        anchor: {
          ordinal: syntheticOrdinal(sc.startTime as number),
          startTime: sc.startTime,
          startMinute: sc.startMinute,
          startGranularity: sc.startGranularity,
          precision: sc.precision,
          source: "scene",
        },
        eventId: null,
      };
    }
    const own = materialByScene.get(sid);
    if (own && own.length > 0) {
      const e = latestEvent(own);
      return {
        anchor: {
          ordinal: e.ordinal,
          startTime: e.startTime,
          startMinute: e.startMinute ?? null,
          startGranularity: e.startGranularity,
          precision: e.precision,
          source: "stamped",
        },
        eventId: e.id,
      };
    }
    return null;
  };

  // 1・2. 今の場面の直接の現在地。
  const direct = directAnchor(sceneId);
  if (direct) return direct;

  // 3. 借りる：読む順で手前の、現在地を持つ最も近い場面。
  const currentIndex = readingOrder.get(sceneId);
  if (currentIndex !== undefined) {
    const candidates = new Set<string>(materialByScene.keys());
    if (sceneChronicle) {
      for (const [sid, sc] of sceneChronicle) {
        if (sceneHasDate(sc)) candidates.add(sid);
      }
    }
    let bestScene: string | null = null;
    let bestIndex = -1;
    for (const candScene of candidates) {
      const idx = readingOrder.get(candScene);
      if (idx === undefined) continue;
      if (idx < currentIndex && idx > bestIndex) {
        bestIndex = idx;
        bestScene = candScene;
      }
    }
    if (bestScene) {
      const da = directAnchor(bestScene);
      if (da) {
        return {
          anchor: { ...da.anchor, source: "proxy", proxySceneId: bestScene },
          eventId: da.eventId,
        };
      }
    }
  }

  // 4. 決まらない。
  return { anchor: { ...NONE_ANCHOR }, eventId: null };
}

/** 今の resolveSceneAnchor と同じ形で、現在地だけを返す。 */
export function resolveSceneAnchorByDate(
  sceneId: string,
  ctx: ChronicleAnchorByDateContext,
): ChronicleAnchor {
  return resolveChronicleAnchorByDate(sceneId, ctx).anchor;
}
