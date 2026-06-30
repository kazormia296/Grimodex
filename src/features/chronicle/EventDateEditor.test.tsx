// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { EventDateEditor } from "./EventDateEditor";
import type { ChronicleCalendar } from "./chronicleTime";

const CAL: ChronicleCalendar = {
  startYear: 1247,
  daysPerYear: 999,
  months: [
    { name: "一月", days: 31 },
    { name: "二月", days: 28 },
  ],
  weekdayNames: [],
  seasonBoundaries: [{ name: "春", startDayOfYear: 0 }],
};

function renderEditor(
  over: Partial<React.ComponentProps<typeof EventDateEditor>>,
) {
  const onPatch = vi.fn();
  const utils = render(
    <EventDateEditor
      calendar={CAL}
      startTime={null}
      startMinute={null}
      startGranularity="none"
      endTime={null}
      endMinute={null}
      endGranularity="none"
      onPatch={onPatch}
      {...over}
    />,
  );
  return { onPatch, ...utils };
}

describe("EventDateEditor", () => {
  it("粒度 none→year で開始年の day 番号を初期化", () => {
    const { onPatch, getByLabelText } = renderEditor({});
    fireEvent.change(getByLabelText("開始の粒度"), {
      target: { value: "year" },
    });
    // startYear=1247 の年頭 day = 0。
    expect(onPatch).toHaveBeenCalledWith({
      startGranularity: "year",
      startTime: 0,
    });
  });

  it("day 粒度で年を変えると day 番号を再計算（dpy=月長合計59）", () => {
    const { onPatch, getByLabelText } = renderEditor({
      startGranularity: "day",
      startTime: 0,
    });
    fireEvent.change(getByLabelText("年"), { target: { value: "1248" } });
    // (1248-1247)*59 + month0 + day1 = 59。
    expect(onPatch).toHaveBeenCalledWith({ startTime: 59 });
  });

  it("月長を超える日付入力は翌月へ桁あふれさせず月末へクランプ", () => {
    const { onPatch, getByLabelText } = renderEditor({
      startGranularity: "day",
      startTime: 31, // 1247年二月1日
    });
    fireEvent.change(getByLabelText("日"), { target: { value: "31" } });
    // 二月は28日なので day31+27 = 58（3月相当へ流さない）。
    expect(onPatch).toHaveBeenCalledWith({ startTime: 58 });
  });

  it("粒度 day→none で時刻系を全クリア", () => {
    const { onPatch, getByLabelText } = renderEditor({
      startGranularity: "day",
      startTime: 100,
    });
    fireEvent.change(getByLabelText("開始の粒度"), {
      target: { value: "none" },
    });
    expect(onPatch).toHaveBeenCalledWith({
      startGranularity: "none",
      startTime: null,
      startMinute: null,
    });
  });
});
