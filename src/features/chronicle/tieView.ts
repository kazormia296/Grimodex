import { cmpKeys } from "@/features/tree/fractionalIndex";

export interface TieViewInput {
  /** reading 順のシーン。 */
  scenes: { id: string; title: string }[];
  /** 出来事（ordinal を持つ）。内部で作中時間順に並べる。 */
  events: { id: string; title: string; ordinal: string }[];
  links: { sceneId: string; eventId: string }[];
  width: number;
  padX: number;
  topY: number;
  bottomY: number;
}

export interface TieDot {
  id: string;
  title: string;
  x: number;
}

export interface Tie {
  sceneId: string;
  eventId: string;
  /** 上トラック(scene) の x。 */
  x1: number;
  /** 下トラック(event) の x。 */
  x2: number;
}

export interface TieViewModel {
  sceneDots: TieDot[];
  eventDots: TieDot[];
  ties: Tie[];
  topY: number;
  bottomY: number;
}

function placeDots(
  items: { id: string; title: string }[],
  width: number,
  padX: number,
): TieDot[] {
  const n = items.length;
  const inner = Math.max(1, width - 2 * padX);
  const step = n > 1 ? inner / (n - 1) : 0;
  return items.map((it, i) => ({
    id: it.id,
    title: it.title,
    x: padX + i * step,
  }));
}

/**
 * reading 順 scene トラック ↔ 作中時間順 event トラックを結ぶタイ線ビューの幾何を組む純関数。
 * 「読む順では前なのに作中では後」のズレが線の交差として現れる。
 * 決定性: scene は与えられた reading 順、event は ordinal 昇順。
 */
export function buildTieView(input: TieViewInput): TieViewModel {
  const { scenes, events, links, width, padX, topY, bottomY } = input;
  const sceneDots = placeDots(scenes, width, padX);
  const orderedEvents = [...events].sort((a, b) =>
    cmpKeys(a.ordinal, b.ordinal),
  );
  const eventDots = placeDots(orderedEvents, width, padX);

  const sceneX = new Map(sceneDots.map((d) => [d.id, d.x]));
  const eventX = new Map(eventDots.map((d) => [d.id, d.x]));

  const ties: Tie[] = [];
  for (const l of links) {
    const x1 = sceneX.get(l.sceneId);
    const x2 = eventX.get(l.eventId);
    if (x1 === undefined || x2 === undefined) continue;
    ties.push({ sceneId: l.sceneId, eventId: l.eventId, x1, x2 });
  }
  ties.sort((p, q) =>
    p.sceneId < q.sceneId
      ? -1
      : p.sceneId > q.sceneId
        ? 1
        : p.eventId < q.eventId
          ? -1
          : p.eventId > q.eventId
            ? 1
            : 0,
  );

  return { sceneDots, eventDots, ties, topY, bottomY };
}
