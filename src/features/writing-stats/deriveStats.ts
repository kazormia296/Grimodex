/**
 * 執筆統計の純関数。`change_events`（domain='editor'）から導いた最小イベント列を
 * 受け取り、日次集計・連続執筆日数（streak）・ヒートマップグリッドを計算する。
 *
 * すべて `now`（unix ms）を注入する純関数なので、タイムゾーンや「今日」に依存する
 * ロジックを決定的にテストできる。日付の丸めはローカルタイムゾーン基準
 * （`Math.floor(ts / 86400000)` の UTC 丸めではない）。
 */

/** 1 件の編集イベントを統計に必要な形へ縮約したもの。 */
export interface WritingEvent {
  /** unix ms */
  timestamp: number;
  /** best-effort で復元した挿入文字数（>= 0、復元不能なら 0） */
  chars: number;
}

export interface DayBucket {
  /** ローカル日キー "YYYY-MM-DD" */
  key: string;
  chars: number;
  events: number;
}

export interface WritingStats {
  /** ローカル日キー -> 集計 */
  byDay: Map<string, DayBucket>;
  todayChars: number;
  todayEvents: number;
  last7Chars: number;
  last7Events: number;
  last30Chars: number;
  last30Events: number;
  /** 今日（未執筆なら昨日）で終わる連続執筆日数 */
  currentStreak: number;
  /** ウィンドウ内の最長連続執筆日数 */
  longestStreak: number;
  /** 執筆した日の総数 */
  activeDays: number;
  totalChars: number;
  totalEvents: number;
  /**
   * いずれかのイベントが文字数を持つか。false の場合、文字数ベースの指標は
   * 信頼できない（payload 復元失敗）ため UI は「操作回数」表示にフォールバックする。
   */
  hasCharData: boolean;
}

export interface HeatmapCell {
  /** ローカル日キー "YYYY-MM-DD" */
  key: string;
  chars: number;
  events: number;
  /** データウィンドウ外（先頭週の前 / 未来日）の埋めセルなら false */
  inRange: boolean;
  /** 0..4 の強度レベル（0 = 無活動） */
  level: number;
}

export interface Heatmap {
  /** 各要素が 1 週（列）。週内は日曜=0 .. 土曜=6 の 7 セル。 */
  weeks: HeatmapCell[][];
  /** 強度算出に使った最大値 */
  max: number;
  /** 強度の元にした指標 */
  metric: "chars" | "events";
}

/** ローカルタイムゾーンの "YYYY-MM-DD"。 */
export function localDayKey(ts: number): string {
  return dayKeyFromDate(new Date(ts));
}

function dayKeyFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 日付の前後移動はミリ秒演算ではなく `Date` のフィールド正規化で行う。
 * これで DST のある日でも「翌日 / 前日」が正しく出る（local midnight の差が
 * 86400000 にならない日があるため）。
 */
function shiftDayKey(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dayKeyFromDate(new Date(y, m - 1, d + delta));
}

/** イベント列から執筆統計を計算する。 */
export function computeWritingStats(
  events: WritingEvent[],
  now: number,
): WritingStats {
  const byDay = new Map<string, DayBucket>();
  let totalChars = 0;
  let totalEvents = 0;

  for (const ev of events) {
    const key = localDayKey(ev.timestamp);
    const bucket = byDay.get(key) ?? { key, chars: 0, events: 0 };
    bucket.chars += ev.chars > 0 ? ev.chars : 0;
    bucket.events += 1;
    byDay.set(key, bucket);
    totalChars += ev.chars > 0 ? ev.chars : 0;
    totalEvents += 1;
  }

  const todayKey = localDayKey(now);

  const windowSum = (days: number) => {
    let chars = 0;
    let evts = 0;
    for (let i = 0; i < days; i++) {
      const b = byDay.get(shiftDayKey(todayKey, -i));
      if (b) {
        chars += b.chars;
        evts += b.events;
      }
    }
    return { chars, evts };
  };

  const today = windowSum(1);
  const last7 = windowSum(7);
  const last30 = windowSum(30);

  return {
    byDay,
    todayChars: today.chars,
    todayEvents: today.evts,
    last7Chars: last7.chars,
    last7Events: last7.evts,
    last30Chars: last30.chars,
    last30Events: last30.evts,
    currentStreak: computeCurrentStreak(byDay, todayKey),
    longestStreak: computeLongestStreak(byDay),
    activeDays: byDay.size,
    totalChars,
    totalEvents,
    hasCharData: totalChars > 0,
  };
}

/**
 * 今日（未執筆なら昨日）から遡って連続する執筆日を数える。今日も昨日も未執筆なら 0。
 * 「今日まだ書いていない」だけで streak が消えないよう、起点を昨日まで許容する。
 */
export function computeCurrentStreak(
  byDay: Map<string, DayBucket>,
  todayKey: string,
): number {
  let cursor: string;
  if (byDay.has(todayKey)) cursor = todayKey;
  else if (byDay.has(shiftDayKey(todayKey, -1)))
    cursor = shiftDayKey(todayKey, -1);
  else return 0;

  let streak = 0;
  while (byDay.has(cursor)) {
    streak += 1;
    cursor = shiftDayKey(cursor, -1);
  }
  return streak;
}

/** ウィンドウ内の最長連続執筆日数。 */
export function computeLongestStreak(byDay: Map<string, DayBucket>): number {
  const keys = [...byDay.keys()].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const key of keys) {
    if (prev !== null && key === shiftDayKey(prev, 1)) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
    prev = key;
  }
  return longest;
}

/**
 * 直近 `weeks` 週ぶんの GitHub 風コントリビューショングリッドを組む。最終列が
 * 今日を含み、各列は日曜始まりの 7 日。先頭週の前と今週の今日以降は埋めセル
 * （inRange=false, level=0）。
 */
export function buildHeatmap(
  stats: WritingStats,
  now: number,
  weeks = 53,
): Heatmap {
  const metric: "chars" | "events" = stats.hasCharData ? "chars" : "events";
  const todayKey = localDayKey(now);

  // 今日を含む週の土曜まで進めてグリッド末尾を確定（列が必ず 7 埋まる）。
  const todayDow = new Date(now).getDay(); // 0=Sun .. 6=Sat
  const endKey = shiftDayKey(todayKey, 6 - todayDow);
  const totalDays = weeks * 7;
  const startKey = shiftDayKey(endKey, -(totalDays - 1));

  // 強度の最大値（埋めセルは除外＝inRange のみ）。
  let max = 0;
  for (const bucket of stats.byDay.values()) {
    const v = metric === "chars" ? bucket.chars : bucket.events;
    if (v > max) max = v;
  }

  const out: HeatmapCell[][] = [];
  let cursor = startKey;
  for (let w = 0; w < weeks; w++) {
    const col: HeatmapCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const bucket = stats.byDay.get(cursor);
      const chars = bucket?.chars ?? 0;
      const events = bucket?.events ?? 0;
      const value = metric === "chars" ? chars : events;
      // 未来日は埋めセル。先頭の startKey 以降はすべて in-range。
      const inRange = cursor <= todayKey;
      col.push({
        key: cursor,
        chars,
        events,
        inRange,
        level: inRange ? intensityLevel(value, max) : 0,
      });
      cursor = shiftDayKey(cursor, 1);
    }
    out.push(col);
  }

  return { weeks: out, max, metric };
}

/** 値を最大値に対する相対比で 0..4 のレベルへ。 */
export function intensityLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const r = value / max;
  if (r > 0.66) return 4;
  if (r > 0.33) return 3;
  if (r > 0.1) return 2;
  return 1;
}
