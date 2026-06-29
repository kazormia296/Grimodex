import { computeAge, type ChronicleCalendar } from "./chronicleTime";

export interface AgeWordEntry {
  words: string[];
  min: number;
  max: number;
}

/** 年齢語辞書（語 → 年齢レンジ[min,max]）。ja/en。max=200 は上限なし相当。 */
export const DEFAULT_AGE_WORDS: AgeWordEntry[] = [
  { words: ["赤ん坊", "赤ちゃん", "嬰児", "baby", "infant"], min: 0, max: 2 },
  { words: ["幼児", "toddler"], min: 1, max: 6 },
  // 「童」は単独だと童話/児童/童謡 に誤反応するため不採用（子供/子ども で十分）。
  { words: ["子供", "子ども", "child"], min: 0, max: 12 },
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

/** 大人 の直後にこの送り仮名が来ると別語(大人しい/大人しく)なので年齢語にしない。 */
const OTONA_OKURIGANA = new Set(["し", "く"]);

/** ASCII(ラテン)語か。語境界(\b)一致を使うかどうかの判定。 */
function isAsciiWord(w: string): boolean {
  return /^[\x20-\x7e]+$/.test(w);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * CJK 年齢語が「別語の接頭辞」でなく現れているか。
 * 大人 は直後が送り仮名(し/く)の occurrence を除外し、大人しい/大人しく を弾く。
 * 他の語は単純な substring 一致（単漢字には語境界が無いため）。
 */
function cjkAgeWordPresent(text: string, needle: string): boolean {
  if (needle !== "大人") return text.includes(needle);
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) return false;
    const next = text[idx + needle.length];
    // 直後が送り仮名でなければ「大人(adult)」の正当な用例とみなす。
    if (next === undefined || !OTONA_OKURIGANA.has(next)) return true;
    from = idx + needle.length;
  }
}

/**
 * テキスト中の年齢語を範囲付きで検出する純関数。
 * - ASCII/ラテン語は語境界(\b)一致・大小無視（adult が adults/adulthood に誤反応しない）。
 * - CJK 語は substring 一致。大人 は送り仮名ガードで大人しい等を除外。
 */
export function detectAgeWords(
  text: string,
  dict: AgeWordEntry[] = DEFAULT_AGE_WORDS,
): AgeWordHit[] {
  if (!text) return [];
  const hits: AgeWordHit[] = [];
  for (const entry of dict) {
    for (const w of entry.words) {
      const matched = isAsciiWord(w)
        ? new RegExp(`\\b${escapeRegExp(w)}\\b`, "i").test(text)
        : cjkAgeWordPresent(text, w);
      if (matched) {
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
    // 暦の年齢表記（満年齢/数え年）と可変年長（閏年）に追従する。
    const age = computeAge(birth, e.startTime, calendar);
    // 出生前(回想/前日譚)の出来事は負の年齢になる。年齢チェックの対象外。
    if (age < 0) continue;
    const sceneIds = [...(linksByEvent.get(e.id) ?? [])].sort();
    for (const sceneId of sceneIds) {
      const text = sceneTexts.get(sceneId);
      if (text === undefined) continue;
      const hits = detectAgeWords(text, ageWords);
      if (hits.length === 0) continue;
      // 検出した年齢語が複数あり、レンジが重ならない(=一人を指せない)場合は
      // 帰属が曖昧なので矛盾を出さない。重なる(=互いに矛盾しない)場合のみ、
      // その共通レンジ[lo,hi]から算出年齢が外れているかを判定する。
      const lo = Math.max(...hits.map((h) => h.min));
      const hi = Math.min(...hits.map((h) => h.max));
      if (lo > hi) continue; // 非重複レンジ → 曖昧な帰属
      if (age < lo || age > hi) {
        for (const hit of hits) {
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
  }
  return conflicts;
}

/** 年齢矛盾に関与する eventId 集合（マーカー警告用）。 */
export function ageConflictEventIds(conflicts: AgeConflict[]): Set<string> {
  return new Set(conflicts.map((c) => c.eventId));
}
