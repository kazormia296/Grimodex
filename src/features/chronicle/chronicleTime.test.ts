import { describe, it, expect } from "vitest";
import {
  seasonOf,
  nextEventOrdinal,
  type ChronicleCalendar,
} from "./chronicleTime";

const CAL: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [
    { name: "春", startDayOfYear: 0 },
    { name: "夏", startDayOfYear: 90 },
    { name: "秋", startDayOfYear: 180 },
    { name: "冬", startDayOfYear: 270 },
  ],
};

describe("seasonOf", () => {
  it("各境界の代表日を正しい季節へ写像", () => {
    expect(seasonOf(0, CAL)).toBe("春");
    expect(seasonOf(100, CAL)).toBe("夏");
    expect(seasonOf(200, CAL)).toBe("秋");
    expect(seasonOf(300, CAL)).toBe("冬");
  });
  it("年をまたいでも mod で循環（720=2年後の0日目→春）", () => {
    expect(seasonOf(720, CAL)).toBe("春");
    expect(seasonOf(720 + 300, CAL)).toBe("冬");
  });
  it("負の時刻も循環で処理（-1→最終日→冬）", () => {
    expect(seasonOf(-1, CAL)).toBe("冬");
  });
  it("最初の境界より前の日（境界が0始まりでない場合）は最後の季節へ巻き戻る", () => {
    const cal: ChronicleCalendar = {
      daysPerYear: 100,
      seasonBoundaries: [
        { name: "A", startDayOfYear: 10 },
        { name: "B", startDayOfYear: 60 },
      ],
    };
    expect(seasonOf(5, cal)).toBe("B");
    expect(seasonOf(10, cal)).toBe("A");
    expect(seasonOf(59, cal)).toBe("A");
    expect(seasonOf(60, cal)).toBe("B");
  });
  it("境界が空 or daysPerYear<=0 なら null", () => {
    expect(seasonOf(10, { daysPerYear: 360, seasonBoundaries: [] })).toBeNull();
    expect(
      seasonOf(10, { daysPerYear: 0, seasonBoundaries: CAL.seasonBoundaries }),
    ).toBeNull();
  });
});

describe("nextEventOrdinal", () => {
  it("空配列なら初期キーを返す", () => {
    expect(typeof nextEventOrdinal([])).toBe("string");
    expect(nextEventOrdinal([]).length).toBeGreaterThan(0);
  });
  it("既存の最大キーより後（cmpKeys で大）のキーを返す", () => {
    const a = nextEventOrdinal([]);
    const b = nextEventOrdinal([a]);
    expect(b > a).toBe(true);
    const c = nextEventOrdinal([a, b]);
    expect(c > b).toBe(true);
  });
});
