import { describe, it, expect } from "vitest";
import {
  computeWritingStats,
  computeCurrentStreak,
  computeLongestStreak,
  buildHeatmap,
  intensityLevel,
  localDayKey,
  computeGoalProgress,
  type WritingEvent,
  type DayBucket,
} from "./deriveStats";

/** ローカル時刻でタイムスタンプを作る（TZ 非依存にテストするため）。 */
function ts(y: number, m: number, d: number, h = 12): number {
  return new Date(y, m - 1, d, h).getTime();
}

function ev(
  y: number,
  m: number,
  d: number,
  chars: number,
  h = 12,
): WritingEvent {
  return { timestamp: ts(y, m, d, h), chars };
}

/** 日キー集合から byDay マップを組む（streak ヘルパのテスト用）。 */
function dayMap(keys: string[]): Map<string, DayBucket> {
  const m = new Map<string, DayBucket>();
  for (const key of keys) m.set(key, { key, chars: 1, events: 1 });
  return m;
}

describe("localDayKey", () => {
  it("ローカル日付を YYYY-MM-DD で返す", () => {
    expect(localDayKey(ts(2026, 6, 17, 9))).toBe("2026-06-17");
    expect(localDayKey(ts(2026, 1, 5, 23))).toBe("2026-01-05");
  });
});

describe("computeWritingStats", () => {
  const now = ts(2026, 6, 17, 15);

  it("空イベントはゼロ・hasCharData=false", () => {
    const s = computeWritingStats([], now);
    expect(s.totalEvents).toBe(0);
    expect(s.totalChars).toBe(0);
    expect(s.activeDays).toBe(0);
    expect(s.currentStreak).toBe(0);
    expect(s.longestStreak).toBe(0);
    expect(s.hasCharData).toBe(false);
  });

  it("同一ローカル日のイベントを集約する", () => {
    const s = computeWritingStats(
      [ev(2026, 6, 17, 100, 9), ev(2026, 6, 17, 50, 18), ev(2026, 6, 16, 30)],
      now,
    );
    expect(s.byDay.get("2026-06-17")).toEqual({
      key: "2026-06-17",
      chars: 150,
      events: 2,
    });
    expect(s.byDay.get("2026-06-16")?.chars).toBe(30);
    expect(s.activeDays).toBe(2);
    expect(s.totalChars).toBe(180);
    expect(s.totalEvents).toBe(3);
    expect(s.hasCharData).toBe(true);
  });

  it("今日 / 直近7日 / 直近30日のウィンドウ集計", () => {
    const s = computeWritingStats(
      [
        ev(2026, 6, 17, 100), // today
        ev(2026, 6, 14, 40), // within 7d
        ev(2026, 6, 1, 25), // within 30d, outside 7d
        ev(2026, 4, 1, 999), // outside 30d
      ],
      now,
    );
    expect(s.todayChars).toBe(100);
    expect(s.last7Chars).toBe(140);
    expect(s.last30Chars).toBe(165);
    expect(s.todayEvents).toBe(1);
    expect(s.last7Events).toBe(2);
    expect(s.last30Events).toBe(3);
  });

  it("文字数が全て 0 でも events は数える（hasCharData=false）", () => {
    const s = computeWritingStats(
      [ev(2026, 6, 17, 0), ev(2026, 6, 17, 0)],
      now,
    );
    expect(s.totalEvents).toBe(2);
    expect(s.totalChars).toBe(0);
    expect(s.hasCharData).toBe(false);
    expect(s.todayEvents).toBe(2);
  });
});

describe("computeCurrentStreak", () => {
  it("今日から連続する執筆日を数える", () => {
    const m = dayMap(["2026-06-17", "2026-06-16", "2026-06-15"]);
    expect(computeCurrentStreak(m, "2026-06-17")).toBe(3);
  });

  it("ギャップで途切れる", () => {
    const m = dayMap(["2026-06-17", "2026-06-15", "2026-06-14"]);
    expect(computeCurrentStreak(m, "2026-06-17")).toBe(1);
  });

  it("今日未執筆でも昨日が起点なら生存", () => {
    const m = dayMap(["2026-06-16", "2026-06-15"]);
    expect(computeCurrentStreak(m, "2026-06-17")).toBe(2);
  });

  it("今日も昨日も未執筆なら 0", () => {
    const m = dayMap(["2026-06-14", "2026-06-13"]);
    expect(computeCurrentStreak(m, "2026-06-17")).toBe(0);
  });

  it("月跨ぎでも連続を維持する", () => {
    const m = dayMap(["2026-06-01", "2026-05-31", "2026-05-30"]);
    expect(computeCurrentStreak(m, "2026-06-01")).toBe(3);
  });
});

describe("computeLongestStreak", () => {
  it("最長連続日数を返す", () => {
    const m = dayMap([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03", // run of 3
      "2026-06-10",
      "2026-06-11", // run of 2
    ]);
    expect(computeLongestStreak(m)).toBe(3);
  });

  it("単日は 1", () => {
    expect(computeLongestStreak(dayMap(["2026-06-05"]))).toBe(1);
  });

  it("空は 0", () => {
    expect(computeLongestStreak(new Map())).toBe(0);
  });
});

describe("intensityLevel", () => {
  it("0 以下はレベル 0", () => {
    expect(intensityLevel(0, "chars")).toBe(0);
    expect(intensityLevel(-5, "events")).toBe(0);
  });

  it("chars を絶対バンドでレベル分けする（少量は淡色に留まる）", () => {
    expect(intensityLevel(1, "chars")).toBe(1);
    expect(intensityLevel(99, "chars")).toBe(1);
    expect(intensityLevel(100, "chars")).toBe(2);
    expect(intensityLevel(399, "chars")).toBe(2);
    expect(intensityLevel(400, "chars")).toBe(3);
    expect(intensityLevel(1199, "chars")).toBe(3);
    expect(intensityLevel(1200, "chars")).toBe(4);
    expect(intensityLevel(99999, "chars")).toBe(4);
  });

  it("events を絶対バンドでレベル分けする（1〜2 回は最濃にならない）", () => {
    expect(intensityLevel(1, "events")).toBe(1);
    expect(intensityLevel(2, "events")).toBe(1);
    expect(intensityLevel(3, "events")).toBe(2);
    expect(intensityLevel(9, "events")).toBe(2);
    expect(intensityLevel(10, "events")).toBe(3);
    expect(intensityLevel(29, "events")).toBe(3);
    expect(intensityLevel(30, "events")).toBe(4);
  });

  it("回帰: 閑散期でも単発の少量編集は level 4（真っ黒）にならない", () => {
    // 旧相対実装ではウィンドウ最大値=自分自身となり 1 回の編集が level 4
    // に化けていた。絶対バンドでは少量は淡色に留まる。
    expect(intensityLevel(5, "chars")).toBe(1);
    expect(intensityLevel(1, "events")).toBe(1);
  });
});

describe("buildHeatmap", () => {
  const now = ts(2026, 6, 17, 12); // 2026-06-17 は水曜
  const stats = computeWritingStats(
    [ev(2026, 6, 17, 100), ev(2026, 6, 10, 50)],
    now,
  );

  it("weeks=53 列・各列 7 セル", () => {
    const hm = buildHeatmap(stats, now, 53);
    expect(hm.weeks).toHaveLength(53);
    for (const col of hm.weeks) expect(col).toHaveLength(7);
  });

  it("最終列に今日が含まれ in-range / 今日以降は埋めセル", () => {
    const hm = buildHeatmap(stats, now, 53);
    const lastCol = hm.weeks[hm.weeks.length - 1];
    const today = lastCol.find((c) => c.key === "2026-06-17");
    expect(today).toBeDefined();
    expect(today?.inRange).toBe(true);
    expect(today?.chars).toBe(100);
    expect(today?.level).toBeGreaterThan(0);
    // 今日より後（同週の木〜土）は埋めセル
    const future = lastCol.filter((c) => c.key > "2026-06-17");
    expect(future.length).toBeGreaterThan(0);
    for (const c of future) {
      expect(c.inRange).toBe(false);
      expect(c.level).toBe(0);
    }
  });

  it("全セルのレベルは 0..4", () => {
    const hm = buildHeatmap(stats, now, 53);
    for (const col of hm.weeks) {
      for (const c of col) {
        expect(c.level).toBeGreaterThanOrEqual(0);
        expect(c.level).toBeLessThanOrEqual(4);
      }
    }
  });

  it("文字データが無いときは events を指標にする", () => {
    const noChars = computeWritingStats(
      [ev(2026, 6, 17, 0), ev(2026, 6, 17, 0)],
      now,
    );
    const hm = buildHeatmap(noChars, now, 53);
    expect(hm.metric).toBe("events");
    expect(hm.max).toBe(2);
  });

  it("回帰: 閑散期に少量だけ書いた過去日は最濃 (level 4) にならない", () => {
    // ウィンドウ内で唯一の活動が「ある過去日に 5 文字」でも、絶対バンドにより
    // level 1（淡色）に留まり、真っ黒には塗られない。
    const quiet = computeWritingStats([ev(2026, 6, 1, 5)], now);
    const hm = buildHeatmap(quiet, now, 53);
    const day = hm.weeks.flat().find((c) => c.key === "2026-06-01");
    expect(day?.chars).toBe(5);
    expect(day?.level).toBe(1);
  });

  it("回帰: 文字復元失敗時も単発イベントの過去日は level 1 止まり", () => {
    const quietEvents = computeWritingStats([ev(2026, 6, 1, 0)], now);
    const hm = buildHeatmap(quietEvents, now, 53);
    expect(hm.metric).toBe("events");
    const day = hm.weeks.flat().find((c) => c.key === "2026-06-01");
    expect(day?.events).toBe(1);
    expect(day?.level).toBe(1);
  });
});

describe("computeGoalProgress", () => {
  it("目標 0 は hasGoal=false（実績は保持する）", () => {
    const p = computeGoalProgress(500, 0);
    expect(p.hasGoal).toBe(false);
    expect(p.current).toBe(500);
    expect(p.remaining).toBe(0);
    expect(p.pct).toBe(0);
    expect(p.reached).toBe(false);
  });

  it("未達: pct を丸め、remaining を出す", () => {
    const p = computeGoalProgress(300, 2000);
    expect(p.hasGoal).toBe(true);
    expect(p.goal).toBe(2000);
    expect(p.current).toBe(300);
    expect(p.remaining).toBe(1700);
    expect(p.pct).toBe(15);
    expect(p.reached).toBe(false);
  });

  it("ちょうど達成: reached=true・remaining=0・pct=100", () => {
    const p = computeGoalProgress(2000, 2000);
    expect(p.reached).toBe(true);
    expect(p.remaining).toBe(0);
    expect(p.pct).toBe(100);
  });

  it("超過: pct は 100 にクランプ・remaining は 0 止まり", () => {
    const p = computeGoalProgress(5000, 2000);
    expect(p.reached).toBe(true);
    expect(p.remaining).toBe(0);
    expect(p.pct).toBe(100);
  });

  it("負の実績は 0 にクランプ", () => {
    const p = computeGoalProgress(-50, 1000);
    expect(p.current).toBe(0);
    expect(p.remaining).toBe(1000);
    expect(p.pct).toBe(0);
  });

  it("負の目標も hasGoal=false 扱い", () => {
    expect(computeGoalProgress(100, -1).hasGoal).toBe(false);
  });
});
