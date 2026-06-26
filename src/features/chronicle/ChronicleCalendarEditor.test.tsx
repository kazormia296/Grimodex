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
    // 4 季 + daysPerYear で number input は 1(daysPerYear)+4(各季の開始日)=5
    const numbers = container.querySelectorAll('input[type="number"]');
    expect(numbers.length).toBe(5);
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
    });
    expect(onClose).toHaveBeenCalled();
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
