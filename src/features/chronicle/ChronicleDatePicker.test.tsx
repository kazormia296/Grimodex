// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ChronicleDatePicker } from "./ChronicleDatePicker";
import {
  dateToDayNumber,
  dayNumberToDate,
  GREGORIAN_MONTH_DAYS,
  GREGORIAN_LEAP,
  type ChronicleCalendar,
} from "./chronicleTime";

const gregorian: ChronicleCalendar = {
  daysPerYear: 365,
  seasonBoundaries: [],
  startYear: 2000,
  months: GREGORIAN_MONTH_DAYS.map((days, i) => ({ name: `${i + 1}月`, days })),
  weekdayNames: ["日", "月", "火", "水", "木", "金", "土"],
  leap: GREGORIAN_LEAP,
};

// 閏対応エンジンと一致する day 番号を commit すること（旧: 線形でドリフトしていた）。
describe("ChronicleDatePicker — グレゴリオ閏整合（data 破損回帰防止）", () => {
  it("2004年1月1日のセルを選ぶと閏考慮の day 番号(1461)を commit", () => {
    const onCommitDay = vi.fn();
    // 開始日 = 2004-01-01 を表示するため day=dateToDayNumber(2004-01-01)。
    const day2004 = dateToDayNumber(
      { year: 2004, monthIndex: 0, dayOfMonth: 1 },
      gregorian,
    );
    const { getByText } = render(
      <ChronicleDatePicker
        which="start"
        granularity="day"
        calendar={gregorian}
        day={day2004}
        minute={0}
        onCommitDay={onCommitDay}
        onCommitMinute={() => {}}
        onClose={() => {}}
        lang="ja"
      />,
    );
    // 日グリッドの「1」を押す（表示中の月=2004年1月）。
    fireEvent.click(getByText("1"));
    expect(onCommitDay).toHaveBeenCalled();
    const committed = onCommitDay.mock.calls.at(-1)![0];
    // commit した day は閏対応エンジンで 2004-01-01 に逆変換できる。
    const back = dayNumberToDate(committed, gregorian);
    expect([back.year, back.monthIndex, back.dayOfMonth]).toEqual([2004, 0, 1]);
    expect(committed).toBe(day2004);
  });

  it("2月グリッドは閏年(2004)で29日まで描く", () => {
    const feb2004 = dateToDayNumber(
      { year: 2004, monthIndex: 1, dayOfMonth: 1 },
      gregorian,
    );
    const { getByText, queryByText } = render(
      <ChronicleDatePicker
        which="start"
        granularity="day"
        calendar={gregorian}
        day={feb2004}
        minute={0}
        onCommitDay={() => {}}
        onCommitMinute={() => {}}
        onClose={() => {}}
        lang="ja"
      />,
    );
    expect(getByText("29")).toBeTruthy();
    expect(queryByText("30")).toBeNull();
  });
});
