// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AttributionLegend } from "./AttributionLegend";

describe("AttributionLegend（本文オーバーレイの凡例）", () => {
  it("AI と unknown の 2 項目を描画する", () => {
    const { container } = render(<AttributionLegend />);
    const items = container.querySelectorAll("[data-legend-source]");
    expect(items).toHaveLength(2);
    expect(container.querySelector("[data-legend-source='ai']")).toBeTruthy();
    expect(
      container.querySelector("[data-legend-source='unknown']"),
    ).toBeTruthy();
  });

  it("human 項目は出さない（本文では human はハイライトされないため）", () => {
    const { container } = render(<AttributionLegend />);
    expect(container.querySelector("[data-legend-source='human']")).toBeNull();
  });

  it("スウォッチは本文オーバーレイと同一の .attribution-* クラスで描画する（凡例＝本文の色が一致）", () => {
    const { container } = render(<AttributionLegend />);
    const aiSwatch = container.querySelector(
      "[data-legend-source='ai'] span[aria-hidden]",
    ) as HTMLElement;
    // 本文オーバーレイと同じ color-mix を共有するため overlay クラスを流用する。
    // 単色トークン（bg-attribution-*）に戻すと凡例と本文の色がずれるので禁止。
    expect(aiSwatch.className.split(" ")).toContain("attribution-ai");
    expect(aiSwatch.className).not.toContain("bg-attribution-ai");
    const unknownSwatch = container.querySelector(
      "[data-legend-source='unknown'] span[aria-hidden]",
    ) as HTMLElement;
    expect(unknownSwatch.className.split(" ")).toContain("attribution-unknown");
    expect(unknownSwatch.className).not.toContain("bg-attribution-unknown");
  });

  it("スクリーンリーダー向けに凡例のラベルを持つ", () => {
    const { container } = render(<AttributionLegend />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("aria-label")).toBeTruthy();
  });

  it("className を合成できる", () => {
    const { container } = render(<AttributionLegend className="text-[10px]" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("text-[10px]");
  });
});
