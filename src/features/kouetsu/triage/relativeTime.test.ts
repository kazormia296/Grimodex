import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./relativeTime";

/** ローカル時刻で Date を組み立てて ISO 文字列にする（TZ 非依存のテスト用）。 */
function isoLocal(
  y: number,
  mon: number,
  day: number,
  h = 0,
  min = 0,
  sec = 0,
): string {
  return new Date(y, mon, day, h, min, sec).toISOString();
}

// 基準時刻: 2026-07-06 15:00:00（ローカル）
const NOW = new Date(2026, 6, 6, 15, 0, 0);

describe("formatRelativeTime", () => {
  it("59 秒前は justNow", () => {
    const iso = new Date(NOW.getTime() - 59_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toEqual({ kind: "justNow" });
  });

  it("ちょうど 60 秒前は minutesAgo(1)", () => {
    const iso = new Date(NOW.getTime() - 60_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toEqual({
      kind: "minutesAgo",
      minutes: 1,
    });
  });

  it("90 秒前は minutesAgo(1)（分は切り捨て）", () => {
    const iso = new Date(NOW.getTime() - 90_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toEqual({
      kind: "minutesAgo",
      minutes: 1,
    });
  });

  it("59 分 59 秒前は minutesAgo(59)", () => {
    const iso = new Date(NOW.getTime() - (59 * 60_000 + 59_000)).toISOString();
    expect(formatRelativeTime(iso, NOW)).toEqual({
      kind: "minutesAgo",
      minutes: 59,
    });
  });

  it("ちょうど 60 分前（同一日）は timeOfDay", () => {
    // 15:00 の 60 分前 = 14:00（同じローカル日）
    expect(formatRelativeTime(isoLocal(2026, 6, 6, 14, 0), NOW)).toEqual({
      kind: "timeOfDay",
      label: "14:00",
    });
  });

  it("同一日の朝はゼロ埋めした HH:MM", () => {
    expect(formatRelativeTime(isoLocal(2026, 6, 6, 9, 5), NOW)).toEqual({
      kind: "timeOfDay",
      label: "09:05",
    });
  });

  it("60 分未満なら日を跨いでも minutesAgo（規則の優先順）", () => {
    // now = 7/6 00:30、対象 = 7/5 23:45（45 分前・前日）
    const now = new Date(2026, 6, 6, 0, 30, 0);
    expect(formatRelativeTime(isoLocal(2026, 6, 5, 23, 45), now)).toEqual({
      kind: "minutesAgo",
      minutes: 45,
    });
  });

  it("前日（60 分以上前）は yesterday", () => {
    expect(formatRelativeTime(isoLocal(2026, 6, 5, 23, 50), NOW)).toEqual({
      kind: "yesterday",
    });
  });

  it("2 日前は date（M/D、ゼロ埋めなし）", () => {
    expect(formatRelativeTime(isoLocal(2026, 6, 4, 12, 0), NOW)).toEqual({
      kind: "date",
      label: "7/4",
    });
  });

  it("前年の日付も date（M/D）", () => {
    expect(formatRelativeTime(isoLocal(2025, 11, 31, 10, 0), NOW)).toEqual({
      kind: "date",
      label: "12/31",
    });
  });

  it("未来時刻は justNow（クロックずれ耐性）", () => {
    const iso = new Date(NOW.getTime() + 5_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toEqual({ kind: "justNow" });
  });

  it("不正な ISO 文字列は null", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBeNull();
    expect(formatRelativeTime("", NOW)).toBeNull();
  });
});
