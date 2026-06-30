// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ChronicleCalendarEditor } from "./ChronicleCalendarEditor";

describe("ChronicleCalendarEditor", () => {
  it("initial=null ならグレゴリオ暦が既定で読み込まれる（12ヶ月・7曜・閏2月）", () => {
    const onSave = vi.fn();
    const { getByText } = render(
      <ChronicleCalendarEditor
        initial={null}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    fireEvent.click(getByText("保存"));
    const cal = onSave.mock.calls[0][0];
    expect(cal.months).toHaveLength(12);
    expect(cal.daysPerYear).toBe(365);
    expect(cal.weekdayNames).toHaveLength(7);
    expect(cal.leap).toEqual({ kind: "gregorian", monthIndex: 1 });
    expect(cal.seasonBoundaries).toHaveLength(4);
    expect(cal.ageReckoning).toBe("full");
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
      leap: { kind: "none" },
      ageReckoning: "full",
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
      leap: { kind: "none" },
      ageReckoning: "full",
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

describe("ChronicleCalendarEditor — リセット/年齢表記", () => {
  it("「リセット」で編集をグレゴリオ暦の既定へ戻して保存", () => {
    const onSave = vi.fn();
    const { getByText } = render(
      <ChronicleCalendarEditor
        initial={{
          daysPerYear: 100,
          seasonBoundaries: [{ name: "雨季", startDayOfYear: 0 }],
          startYear: 500,
          months: [
            { name: "A月", days: 50 },
            { name: "B月", days: 50 },
          ],
          weekdayNames: ["甲", "乙"],
          leap: { kind: "none" },
          ageReckoning: "full",
        }}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    fireEvent.click(getByText("リセット"));
    fireEvent.click(getByText("数え年"));
    fireEvent.click(getByText("保存"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const cal = onSave.mock.calls[0][0];
    expect(cal.months).toHaveLength(12);
    expect(cal.daysPerYear).toBe(365);
    expect(cal.leap).toEqual({ kind: "gregorian", monthIndex: 1 });
    expect(cal.ageReckoning).toBe("counting");
    expect(cal.weekdayNames).toHaveLength(7);
    expect(cal.seasonBoundaries).toHaveLength(4);
    expect(cal.startYear).toBe(0);
  });

  it("月が無ければ閏は none に落ちる（gregorian は月前提）", () => {
    const onSave = vi.fn();
    const { getByText } = render(
      <ChronicleCalendarEditor
        initial={{
          daysPerYear: 365,
          seasonBoundaries: [{ name: "春", startDayOfYear: 0 }],
          startYear: 0,
          months: [],
          weekdayNames: [],
          leap: { kind: "gregorian", monthIndex: 1 },
          ageReckoning: "full",
        }}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    fireEvent.click(getByText("保存"));
    expect(onSave.mock.calls[0][0].leap).toEqual({ kind: "none" });
  });
});
