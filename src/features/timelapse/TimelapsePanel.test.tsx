// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimelapsePanel } from "./TimelapsePanel";

describe("TimelapsePanel", () => {
  it("renders a pointer to the Export dialog (export moved out of the panel, #8)", () => {
    render(<TimelapsePanel />);
    expect(screen.getByTestId("timelapse-panel")).toBeTruthy();
    // The export action now lives in the Export dialog's Timelapse tab.
    expect(screen.queryByTestId("timelapse-export-video")).toBeNull();
  });
});
