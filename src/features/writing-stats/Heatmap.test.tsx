// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Heatmap } from "./Heatmap";
import type { Heatmap as HeatmapData, HeatmapCell } from "./deriveStats";

function cell(key: string, chars: number, inRange = true): HeatmapCell {
  return { key, chars, events: 0, inRange, level: chars > 0 ? 2 : 0 };
}

function makeHeatmap(): HeatmapData {
  // 1 週分 (日曜始まり 7 セル)。先頭 2 セルはウィンドウ外の埋めセル。
  const week: HeatmapCell[] = [
    cell("2026-06-28", 0, false),
    cell("2026-06-29", 0, false),
    cell("2026-06-30", 150),
    cell("2026-07-01", 0),
    cell("2026-07-02", 42),
    cell("2026-07-03", 0),
    cell("2026-07-04", 0),
  ];
  return { weeks: [week], max: 150, metric: "chars" };
}

describe("Heatmap a11y (WCAG 1.1.1)", () => {
  it("ウィンドウ内セルは role=img と日付+値の accessible name を持つ", () => {
    render(<Heatmap heatmap={makeHeatmap()} />);
    const imgs = screen.getAllByRole("img");
    expect(imgs).toHaveLength(5); // inRange のセルのみ
    const labels = imgs.map((el) => el.getAttribute("aria-label"));
    expect(
      labels.some((l) => l?.includes("2026-06-30") && l.includes("150")),
    ).toBe(true);
  });

  it("ウィンドウ外の埋めセルは aria-hidden のまま", () => {
    const { container } = render(<Heatmap heatmap={makeHeatmap()} />);
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBe(2);
    for (const el of hidden) {
      expect(el.getAttribute("role")).toBeNull();
      expect(el.getAttribute("aria-label")).toBeNull();
    }
  });
});
