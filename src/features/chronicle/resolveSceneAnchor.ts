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
  /** アンカー出来事の時刻（分・0..1439）。null=時刻未設定。 */
  startMinute: number | null;
  /** アンカー出来事の日付の粒度（none/year/season/month/day/time）。既定 "none"。 */
  startGranularity: string;
  /** アンカー出来事の日付の確度。none アンカーは null。 */
  precision: EventPrecision | null;
  /**
   * scene=シーン自身の暦日付 / stamped=シーン直結 event /
   * proxy=前方最近シーンの代理 / none=未確定（オフページのみ）。
   */
  source: "scene" | "stamped" | "proxy" | "none";
  /** source=proxy のとき、代理元シーン。 */
  proxySceneId?: string;
}

/**
 * シーン自身が持つ作中暦日付（events と同じ日付モデルをシーンへ共有）。
 * シーンが「日付を持つ」= `startGranularity !== "none" && startTime != null`。
 */
export interface SceneChronicle {
  startTime: number | null;
  startMinute: number | null;
  startGranularity: string;
  precision: EventPrecision;
}

type MinEvent = Pick<
  EventRow,
  | "id"
  | "ordinal"
  | "startTime"
  | "startMinute"
  | "startGranularity"
  | "precision"
>;

/** シーンが暦日付を持つか（明示設定時のみ scene-own アンカーが発火する条件）。 */
function sceneHasDate(sc: SceneChronicle | undefined): sc is SceneChronicle {
  return !!sc && sc.startGranularity !== "none" && sc.startTime != null;
}

/**
 * シーンの作中時刻アンカーを解決する（純関数・v2）。
 *
 * 各シーンの「直接アンカー(directAnchor)」を次の優先で決める:
 *  1. scene-own : そのシーンが暦日付を持つ → source="scene"。
 *                 ordinal は syntheticOrdinal(startTime)（時刻基準の順序比較用）。
 *  2. stamped   : 紐づく event 群の ordinal 最大 → source="stamped"。
 * （scene-own を stamped より優先。シーン日付は明示設定時のみ発火するので、
 *   日付未設定シーンでは従来の stamped-only 挙動が不変。）
 *
 * 解決順:
 *  - 現在シーンに directAnchor があればそれを返す（"scene" か "stamped"）。
 *  - 無ければ reading-order 上で**現在シーンより前方**の最も近い「directAnchor を
 *    持つシーン」を代理採用（proxy）。後方（未来）は見ない＝フラッシュバックで
 *    未来時刻に誤 anchor しない。proxy は元の directAnchor の暦フィールドを運び
 *    source="proxy"・proxySceneId を設定。
 *  - 前方にも無ければ none（D1: オフページ背景のみ注入する専用モード）。
 */
export function resolveSceneAnchor(
  sceneId: string,
  ctx: {
    sceneEvents: SceneEventRow[];
    events: MinEvent[];
    /** computeGlobalSceneOrder(nodes) — ChroniclePanel / Timeline と同じ正本。 */
    readingOrder: Map<string, number>;
    /** sceneId → そのシーン自身の暦日付。日付を持つシーンが scene-own アンカー源。 */
    sceneChronicle?: Map<string, SceneChronicle>;
  },
): ChronicleAnchor {
  const { sceneEvents, events, readingOrder, sceneChronicle } = ctx;
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

  /**
   * 時刻 t における「synthetic ordinal」: startTime != null && startTime <= t の
   * event のうち startTime 最大（同点は ordinal 最大）の ordinal。該当なしは ""。
   * → scene-own アンカーでも recent/offpage/causal/character 選定（ordinal 比較）が
   *   時刻基準で機能する。
   */
  const syntheticOrdinal = (t: number): string => {
    let best: MinEvent | null = null;
    for (const e of events) {
      const st = e.startTime;
      if (st == null || st > t) continue;
      if (
        best == null ||
        st > best.startTime! ||
        (st === best.startTime && cmpKeys(e.ordinal, best.ordinal) > 0)
      ) {
        best = e;
      }
    }
    return best ? best.ordinal : "";
  };

  /** シーンの directAnchor（scene-own → stamped）。無ければ null。 */
  const directAnchor = (sid: string): ChronicleAnchor | null => {
    const sc = sceneChronicle?.get(sid);
    if (sceneHasDate(sc)) {
      return {
        ordinal: syntheticOrdinal(sc.startTime as number),
        startTime: sc.startTime,
        startMinute: sc.startMinute,
        startGranularity: sc.startGranularity,
        precision: sc.precision,
        source: "scene",
      };
    }
    const own = stampedByScene.get(sid);
    if (own && own.length > 0) {
      const e = maxOrdinal(own);
      return {
        ordinal: e.ordinal,
        startTime: e.startTime,
        startMinute: e.startMinute ?? null,
        startGranularity: e.startGranularity ?? "none",
        precision: e.precision,
        source: "stamped",
      };
    }
    return null;
  };

  // 1. 現在シーンの directAnchor（"scene" か "stamped"）。
  const direct = directAnchor(sceneId);
  if (direct) return direct;

  // 2. proxy — 前方(index 小)で最も近い「directAnchor を持つシーン」。
  const currentIndex = readingOrder.get(sceneId);
  if (currentIndex !== undefined) {
    // 候補 = stamp 済シーン ∪ 暦日付を持つシーン（どちらも directAnchor を持つ）。
    const candidates = new Set<string>(stampedByScene.keys());
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
        return { ...da, source: "proxy", proxySceneId: bestScene };
      }
    }
  }

  // 3. none
  return {
    ordinal: "",
    startTime: null,
    startMinute: null,
    startGranularity: "none",
    precision: null,
    source: "none",
  };
}
