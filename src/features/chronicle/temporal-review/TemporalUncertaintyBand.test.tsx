// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TemporalUncertaintyBand } from "./TemporalUncertaintyBand";
import { MINUTES_PER_DAY } from "@/features/narrative-extraction/temporal/resolution";

describe("TemporalUncertaintyBand", () => {
  it("labels an exact domain as 確定 and never mentions duration", () => {
    render(
      <TemporalUncertaintyBand
        label="開始"
        domain={{ earliest: 5 * MINUTES_PER_DAY, latest: 5 * MINUTES_PER_DAY }}
      />,
    );
    const band = screen.getByTestId("temporal-uncertainty-band");
    expect(band).toHaveAttribute("data-band-state", "exact");
    const track = screen.getByRole("img");
    expect(track.getAttribute("aria-label")).toContain("確定");
    expect(track.getAttribute("aria-label")).not.toContain("期間");
  });

  it("labels a bounded domain as 不確実範囲, distinct from duration wording", () => {
    render(
      <TemporalUncertaintyBand
        label="開始"
        domain={{ earliest: 2 * MINUTES_PER_DAY, latest: 6 * MINUTES_PER_DAY }}
      />,
    );
    const track = screen.getByRole("img");
    expect(track.getAttribute("aria-label")).toContain("不確実範囲");
    expect(track.getAttribute("aria-label")).not.toContain("期間");
  });

  it("renders an open-ended domain without inventing a fake bound", () => {
    render(
      <TemporalUncertaintyBand
        label="終了"
        domain={{ earliest: 3 * MINUTES_PER_DAY, latest: null }}
      />,
    );
    const band = screen.getByTestId("temporal-uncertainty-band");
    expect(band).toHaveAttribute("data-band-state", "bounded");
    expect(screen.getByText(/day 3〜/)).toBeInTheDocument();
  });

  it("renders an unknown domain distinctly", () => {
    render(
      <TemporalUncertaintyBand
        label="開始"
        domain={{ earliest: null, latest: null }}
      />,
    );
    const band = screen.getByTestId("temporal-uncertainty-band");
    expect(band).toHaveAttribute("data-band-state", "unknown");
    expect(screen.getByText("不明")).toBeInTheDocument();
  });
});
