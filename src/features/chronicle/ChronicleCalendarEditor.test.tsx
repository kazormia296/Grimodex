// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ChronicleCalendarEditor } from "./ChronicleCalendarEditor";

describe("ChronicleCalendarEditor", () => {
  it("initial=null なら既定4季で開く", () => {
    const { container } = render(
      <ChronicleCalendarEditor
        initial={null}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );
    // startYear(1) + daysPerYear(1) + 4 季の開始日(4) = 6（月は初期0行）
    const numbers = container.querySelectorAll('input[type="number"]');
    expect(numbers.length).toBe(6);
  });

  it("保存で空名季節を除き昇順に正規化して onSave", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { getByText } = render(
      <ChronicleCalendarEditor
        initial={{
          daysPerYear: 100,
          seasonBoundaries: [
            { name: "夏", startDayOfYear: 60 },
            { name: "", startDayOfYear: 30 }, // 空名 → 除外
            { name: "冬", startDayOfYear: 10 },
          ],
        }}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(getByText("保存"));
    expect(onSave).toHaveBeenCalledWith({
      daysPerYear: 100,
      seasonBoundaries: [
        { name: "冬", startDayOfYear: 10 },
        { name: "夏", startDayOfYear: 60 },
      ],
      startYear: 0,
      months: [],
      weekdayNames: [],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("月を定義すると daysPerYear は月長合計に導出される", () => {
    const onSave = vi.fn();
    const { getByText } = render(
      <ChronicleCalendarEditor
        initial={{
          daysPerYear: 999,
          seasonBoundaries: [],
          startYear: 1247,
          months: [
            { name: "一月", days: 31 },
            { name: "二月", days: 28 },
          ],
          weekdayNames: ["月", "火"],
        }}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    fireEvent.click(getByText("保存"));
    // seasonBoundaries=[] は既定4季にフォールバックする（既存仕様）。
    expect(onSave).toHaveBeenCalledWith({
      daysPerYear: 59,
      seasonBoundaries: [
        { name: "春", startDayOfYear: 0 },
        { name: "夏", startDayOfYear: 90 },
        { name: "秋", startDayOfYear: 180 },
        { name: "冬", startDayOfYear: 270 },
      ],
      startYear: 1247,
      months: [
        { name: "一月", days: 31 },
        { name: "二月", days: 28 },
      ],
      weekdayNames: ["月", "火"],
    });
  });

  it("キャンセルで onClose のみ", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { getByText } = render(
      <ChronicleCalendarEditor
        initial={null}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(getByText("キャンセル"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
