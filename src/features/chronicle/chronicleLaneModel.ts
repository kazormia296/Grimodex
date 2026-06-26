import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { EventPrecision } from "@/db/schema";

export interface LaneInputEvent {
  id: string;
  primaryCodexId: string | null;
  ordinal: string;
  precision: EventPrecision;
  /** scene 参照0=オフページ（中空マーカー）。 */
  isOffpage: boolean;
  /** endTime あり=interval。 */
  isInterval: boolean;
}

export interface LanePerson {
  id: string;
  name: string;
}

export interface ChronicleLaneMarker {
  eventId: string;
  ordinal: string;
  precision: EventPrecision;
  isOffpage: boolean;
  isInterval: boolean;
}

export interface ChronicleLane {
  codexId: string;
  name: string;
  /** レーン中心 y(px)。 */
  y: number;
  markers: ChronicleLaneMarker[];
}

export interface ChronicleLaneModel {
  lanes: ChronicleLane[];
  laneHeight: number;
  contentHeight: number;
  /** primaryCodexId が null/未知の出来事（人物レーンに乗らない）。 */
  unassigned: ChronicleLaneMarker[];
}

const DEFAULT_LANE_TOP = 8;
const DEFAULT_LANE_HEIGHT = 44;

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toMarker(e: LaneInputEvent): ChronicleLaneMarker {
  return {
    eventId: e.id,
    ordinal: e.ordinal,
    precision: e.precision,
    isOffpage: e.isOffpage,
    isInterval: e.isInterval,
  };
}

/**
 * 出来事と人物 codex から「人物レーン年表」モデルを組む純関数。
 * - primary に1件以上ある人物だけレーン化（空レーンを作らない）。
 * - レーン順は (name, id) 昇順で決定的。marker は ordinal 昇順。
 * - primaryCodexId が null/未知の出来事は unassigned 行へ。
 * 決定性: 乱数/時刻なし。
 */
export function buildChronicleLaneModel(args: {
  events: LaneInputEvent[];
  people: LanePerson[];
  laneTop?: number;
  laneHeight?: number;
}): ChronicleLaneModel {
  const {
    events,
    people,
    laneTop = DEFAULT_LANE_TOP,
    laneHeight = DEFAULT_LANE_HEIGHT,
  } = args;

  const personById = new Map(people.map((p) => [p.id, p]));
  const markersByPerson = new Map<string, ChronicleLaneMarker[]>();
  const unassigned: ChronicleLaneMarker[] = [];

  for (const e of events) {
    const pid = e.primaryCodexId;
    if (pid && personById.has(pid)) {
      const arr = markersByPerson.get(pid);
      if (arr) arr.push(toMarker(e));
      else markersByPerson.set(pid, [toMarker(e)]);
    } else {
      unassigned.push(toMarker(e));
    }
  }

  const orderedPeople = [...markersByPerson.keys()]
    .map((id) => personById.get(id)!)
    .sort((a, b) => {
      const c = cmpId(a.name, b.name);
      return c !== 0 ? c : cmpId(a.id, b.id);
    });

  const lanes: ChronicleLane[] = orderedPeople.map((p, i) => {
    const markers = (markersByPerson.get(p.id) ?? []).sort((a, b) =>
      cmpKeys(a.ordinal, b.ordinal),
    );
    return {
      codexId: p.id,
      name: p.name,
      y: laneTop + i * laneHeight + laneHeight / 2,
      markers,
    };
  });

  unassigned.sort((a, b) => cmpKeys(a.ordinal, b.ordinal));

  return {
    lanes,
    laneHeight,
    contentHeight: laneTop + lanes.length * laneHeight,
    unassigned,
  };
}
