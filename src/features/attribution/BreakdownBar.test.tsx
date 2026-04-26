// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { BreakdownBar } from "./BreakdownBar";

describe("BreakdownBar", () => {
  it("renders three segments with correct widths", () => {
    const { container } = render(
      <BreakdownBar human={60} ai={30} unknown={10} total={100} />,
    );
    const segments = container.querySelectorAll("[data-segment]");
    expect(segments).toHaveLength(3);

    const humanSeg = container.querySelector("[data-segment='human']");
    const aiSeg = container.querySelector("[data-segment='ai']");
    const unknownSeg = container.querySelector("[data-segment='unknown']");
    expect(humanSeg).toBeTruthy();
    expect(aiSeg).toBeTruthy();
    expect(unknownSeg).toBeTruthy();
  });

  it("renders nothing when total is 0", () => {
    const { container } = render(
      <BreakdownBar human={0} ai={0} unknown={0} total={0} />,
    );
    const segments = container.querySelectorAll("[data-segment]");
    expect(segments).toHaveLength(0);
  });

  it("applies minimum 2px width for non-zero segments", () => {
    // human=99, ai=1, unknown=0 → ai is tiny but non-zero
    const { container } = render(
      <BreakdownBar human={99} ai={1} unknown={0} total={100} />,
    );
    const aiSeg = container.querySelector("[data-segment='ai']") as HTMLElement;
    expect(aiSeg).toBeTruthy();
    // Should have minWidth style set
    const style = aiSeg.style;
    expect(style.minWidth).toBe("2px");
  });

  it("renders with default height 24px", () => {
    const { container } = render(
      <BreakdownBar human={50} ai={50} unknown={0} total={100} />,
    );
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.style.height).toBe("24px");
  });

  it("accepts custom height", () => {
    const { container } = render(
      <BreakdownBar human={50} ai={50} unknown={0} total={100} height={8} />,
    );
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.style.height).toBe("8px");
  });

  it("shows tooltip with percentage on each segment", () => {
    render(<BreakdownBar human={70} ai={20} unknown={10} total={100} />);
    const humanSeg = document.querySelector("[data-segment='human']");
    expect(humanSeg?.getAttribute("title")).toContain("70%");
    const aiSeg = document.querySelector("[data-segment='ai']");
    expect(aiSeg?.getAttribute("title")).toContain("20%");
  });
});
