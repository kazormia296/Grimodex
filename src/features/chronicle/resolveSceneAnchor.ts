import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { EventPrecision } from "@/db/schema";
import type { EventRow, SceneEventRow } from "./api";

/**
 * 現在シーンの「作中時刻アンカー」。
 * ordinal（順序比較）と startTime（暦＝季節/年齢/生死）は別軸（spec §1 時刻二軸）。
 */
export interface ChronicleAnchor {
  /** 順序比較・直近イベント選定に使う fractional index。none のとき "". */
  ordinal: string;
  /** 紀元からの日数。null=暦未設定/未確定 → 季節・年齢セクションは省略。 */
  startTime: number | null;
  /** アンカー出来事の日付の確度。none アンカーは null。 */
  precision: EventPrecision | null;
  /** stamped=シーン直結 / proxy=前方最近シーンの代理 / none=未確定（オフページのみ）。 */
  source: "stamped" | "proxy" | "none";
  /** source=proxy のとき、代理元シーン。 */
  proxySceneId?: string;
}

type MinEvent = Pick<EventRow, "id" | "ordinal" | "startTime" | "precision">;

/**
 * シーンの作中時刻アンカーを解決する（純関数）。
 *
 * 1. 現在シーンに stamp 済 scene_events があれば、紐づく event の ordinal 最大を採用（stamped）。
 * 2. 無ければ reading-order 上で**現在シーンより前方**の最も近い stamp 済シーンを代理採用（proxy）。
 *    後方（未来）stamp は見ない＝フラッシュバックで未来時刻に誤 anchor しない。
 * 3. 前方にも無ければ none（D1: オフページ背景のみ注入する専用モード）。
 */
export function resolveSceneAnchor(
  sceneId: string,
  ctx: {
    sceneEvents: SceneEventRow[];
    events: MinEvent[];
    /** computeGlobalSceneOrder(nodes) — ChroniclePanel / Timeline と同じ正本。 */
    readingOrder: Map<string, number>;
  },
): ChronicleAnchor {
  const { sceneEvents, events, readingOrder } = ctx;
  const eventById = new Map(events.map((e) => [e.id, e] as const));

  // sceneId → 紐づく(events に実在する)event 群。孤児 stamp は無視。
  const stampedByScene = new Map<string, MinEvent[]>();
  for (const se of sceneEvents) {
    const ev = eventById.get(se.eventId);
    if (!ev) continue;
    const arr = stampedByScene.get(se.sceneId);
    if (arr) arr.push(ev);
    else stampedByScene.set(se.sceneId, [ev]);
  }

  const maxOrdinal = (evs: MinEvent[]): MinEvent =>
    evs.reduce((best, e) => (cmpKeys(e.ordinal, best.ordinal) > 0 ? e : best));

  // 1. stamped
  const own = stampedByScene.get(sceneId);
  if (own && own.length > 0) {
    const e = maxOrdinal(own);
    return {
      ordinal: e.ordinal,
      startTime: e.startTime,
      precision: e.precision,
      source: "stamped",
    };
  }

  // 2. proxy — 前方(index 小)で最も近い stamp 済シーン
  const currentIndex = readingOrder.get(sceneId);
  if (currentIndex !== undefined) {
    let bestScene: string | null = null;
    let bestIndex = -1;
    for (const candScene of stampedByScene.keys()) {
      const idx = readingOrder.get(candScene);
      if (idx === undefined) continue;
      if (idx < currentIndex && idx > bestIndex) {
        bestIndex = idx;
        bestScene = candScene;
      }
    }
    if (bestScene) {
      const e = maxOrdinal(stampedByScene.get(bestScene)!);
      return {
        ordinal: e.ordinal,
        startTime: e.startTime,
        precision: e.precision,
        source: "proxy",
        proxySceneId: bestScene,
      };
    }
  }

  // 3. none
  return { ordinal: "", startTime: null, precision: null, source: "none" };
}
