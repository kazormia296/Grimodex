// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TensionCurve } from "./TensionCurve";
import type { TensionPoint } from "./tensionSeries";

const series: TensionPoint[] = [
  {
    sceneId: "s1",
    title: "出会い",
    tension: 0.6,
    parentId: "f1",
    isChapterEnd: false,
  },
  {
    sceneId: "s2",
    title: "停滞",
    tension: 0.2,
    parentId: "f1",
    isChapterEnd: true,
  },
  {
    sceneId: "s3",
    title: "急転",
    tension: 0.9,
    parentId: "f2",
    isChapterEnd: true,
  },
];

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe("TensionCurve", () => {
  it("tension を持つ点を描画する（null 以外）", () => {
    render(<TensionCurve series={series} saggy={[]} onSelectScene={vi.fn()} />);
    expect(screen.getAllByTestId(/^tension-point-/)).toHaveLength(3);
  });
  it("点クリックで onSelectScene を呼ぶ", () => {
    const onSelect = vi.fn();
    render(
      <TensionCurve series={series} saggy={[]} onSelectScene={onSelect} />,
    );
    fireEvent.click(screen.getByTestId("tension-point-s3"));
    expect(onSelect).toHaveBeenCalledWith("s3");
  });
  it("中だるみ帯を描画する", () => {
    render(
      <TensionCurve
        series={series}
        saggy={[{ startIdx: 0, endIdx: 1 }]}
        onSelectScene={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tension-saggy-0")).toBeInTheDocument();
  });
  it("章末マーカーを描画する", () => {
    render(<TensionCurve series={series} saggy={[]} onSelectScene={vi.fn()} />);
    expect(screen.getByTestId("tension-chapterend-s2")).toBeInTheDocument();
    expect(screen.getByTestId("tension-chapterend-s3")).toBeInTheDocument();
  });
});
