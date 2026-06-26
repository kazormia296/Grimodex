import { seasonOf, type ChronicleCalendar } from "./chronicleTime";
import { detectSeasons } from "./seasonDetect";

export interface SeasonConflict {
  eventId: string;
  sceneId: string;
  /** 出来事の時刻から導いた季節。 */
  eventSeason: string;
  /** シーン本文が示す、eventSeason と矛盾する季節。 */
  sceneSeasons: string[];
}

export interface SeasonCheckInput {
  events: { id: string; startTime: number | null }[];
  calendar: ChronicleCalendar;
  /** scene↔event リンク。 */
  links: { sceneId: string; eventId: string }[];
  /** sceneId → 本文プレーンテキスト。 */
  sceneTexts: Map<string, string>;
  synonyms?: Record<string, string[]>;
}

/**
 * 「出来事の時刻が示す季節」と「参照シーン本文が示す季節」の矛盾を検出する純関数。
 * 例: 冬に配置した出来事のシーンに「蝉」が出てくる → 矛盾。
 * startTime 無し / 暦未設定 / シーン本文未取得 のものはスキップ（false-positive を出さない）。
 * 決定性: 乱数/時刻なし。
 */
export function findSeasonConflicts(input: SeasonCheckInput): SeasonConflict[] {
  const { events, calendar, links, sceneTexts, synonyms } = input;
  const seasonNames = calendar.seasonBoundaries.map((b) => b.name);
  if (seasonNames.length === 0) return [];

  const eventSeason = new Map<string, string>();
  for (const e of events) {
    if (e.startTime == null) continue;
    const s = seasonOf(e.startTime, calendar);
    if (s) eventSeason.set(e.id, s);
  }

  const linksByEvent = new Map<string, string[]>();
  for (const l of links) {
    const arr = linksByEvent.get(l.eventId);
    if (arr) arr.push(l.sceneId);
    else linksByEvent.set(l.eventId, [l.sceneId]);
  }

  const conflicts: SeasonConflict[] = [];
  // 決定的順序: eventId 昇順 → sceneId 昇順。
  const eventIds = [...eventSeason.keys()].sort();
  for (const eventId of eventIds) {
    const evSeason = eventSeason.get(eventId)!;
    const sceneIds = [...(linksByEvent.get(eventId) ?? [])].sort();
    for (const sceneId of sceneIds) {
      const text = sceneTexts.get(sceneId);
      if (text === undefined) continue;
      const detected = detectSeasons(text, seasonNames, synonyms);
      const conflicting = [...detected].filter((s) => s !== evSeason).sort();
      if (conflicting.length > 0) {
        conflicts.push({
          eventId,
          sceneId,
          eventSeason: evSeason,
          sceneSeasons: conflicting,
        });
      }
    }
  }
  return conflicts;
}

/** 矛盾のある eventId 集合（マーカー警告表示用）。 */
export function conflictingEventIds(conflicts: SeasonConflict[]): Set<string> {
  return new Set(conflicts.map((c) => c.eventId));
}
