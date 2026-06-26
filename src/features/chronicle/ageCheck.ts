import type { ChronicleCalendar } from "./chronicleTime";

export interface AgeWordEntry {
  words: string[];
  min: number;
  max: number;
}

/** 年齢語辞書（語 → 年齢レンジ[min,max]）。ja/en。max=200 は上限なし相当。 */
export const DEFAULT_AGE_WORDS: AgeWordEntry[] = [
  { words: ["赤ん坊", "赤ちゃん", "嬰児", "baby", "infant"], min: 0, max: 2 },
  { words: ["幼児", "toddler"], min: 1, max: 6 },
  { words: ["子供", "子ども", "童", "child"], min: 0, max: 12 },
  { words: ["少年", "少女", "boy", "girl"], min: 7, max: 17 },
  { words: ["青年", "若者", "youth"], min: 16, max: 35 },
  { words: ["中年", "middle-aged"], min: 40, max: 65 },
  { words: ["大人", "成人", "adult"], min: 18, max: 200 },
  {
    words: [
      "老人",
      "老婆",
      "老爺",
      "年寄り",
      "elderly",
      "old man",
      "old woman",
    ],
    min: 60,
    max: 200,
  },
];

export interface AgeWordHit {
  word: string;
  min: number;
  max: number;
}

/** テキスト中の年齢語を範囲付きで検出する純関数（ASCII 大小無視）。 */
export function detectAgeWords(
  text: string,
  dict: AgeWordEntry[] = DEFAULT_AGE_WORDS,
): AgeWordHit[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const hits: AgeWordHit[] = [];
  for (const entry of dict) {
    for (const w of entry.words) {
      if (text.includes(w) || lower.includes(w.toLowerCase())) {
        hits.push({ word: w, min: entry.min, max: entry.max });
        break;
      }
    }
  }
  return hits;
}

export interface AgeConflict {
  eventId: string;
  sceneId: string;
  codexId: string;
  computedAge: number;
  ageWord: string;
  expectedRange: [number, number];
}

export interface AgeCheckInput {
  events: {
    id: string;
    primaryCodexId: string | null;
    startTime: number | null;
    kind: string;
  }[];
  calendar: ChronicleCalendar;
  links: { sceneId: string; eventId: string }[];
  sceneTexts: Map<string, string>;
  ageWords?: AgeWordEntry[];
}

/**
 * 出生(kind='birth')からの年齢と、参照シーン本文の年齢語の矛盾を検出する純関数。
 * 例: 出生から40年後の出来事のシーンに「子供」→ 矛盾。
 * birth 不明 / startTime 欠如 / 暦未設定 はスキップ（false-positive 回避）。
 * 決定性: 順序は (eventId, sceneId, word)。
 */
export function findAgeConflicts(input: AgeCheckInput): AgeConflict[] {
  const { events, calendar, links, sceneTexts, ageWords } = input;
  if (calendar.daysPerYear <= 0) return [];

  const birthByCodex = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "birth" && e.primaryCodexId && e.startTime != null) {
      // 最も早い birth を採用。
      const prev = birthByCodex.get(e.primaryCodexId);
      if (prev == null || e.startTime < prev) {
        birthByCodex.set(e.primaryCodexId, e.startTime);
      }
    }
  }

  const linksByEvent = new Map<string, string[]>();
  for (const l of links) {
    const arr = linksByEvent.get(l.eventId);
    if (arr) arr.push(l.sceneId);
    else linksByEvent.set(l.eventId, [l.sceneId]);
  }

  const conflicts: AgeConflict[] = [];
  const orderedEvents = [...events].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const e of orderedEvents) {
    if (!e.primaryCodexId || e.startTime == null) continue;
    const birth = birthByCodex.get(e.primaryCodexId);
    if (birth == null) continue;
    const age = Math.floor((e.startTime - birth) / calendar.daysPerYear);
    const sceneIds = [...(linksByEvent.get(e.id) ?? [])].sort();
    for (const sceneId of sceneIds) {
      const text = sceneTexts.get(sceneId);
      if (text === undefined) continue;
      for (const hit of detectAgeWords(text, ageWords)) {
        if (age < hit.min || age > hit.max) {
          conflicts.push({
            eventId: e.id,
            sceneId,
            codexId: e.primaryCodexId,
            computedAge: age,
            ageWord: hit.word,
            expectedRange: [hit.min, hit.max],
          });
        }
      }
    }
  }
  return conflicts;
}

/** 年齢矛盾に関与する eventId 集合（マーカー警告用）。 */
export function ageConflictEventIds(conflicts: AgeConflict[]): Set<string> {
  return new Set(conflicts.map((c) => c.eventId));
}
