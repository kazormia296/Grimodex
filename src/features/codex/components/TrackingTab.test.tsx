// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrackingTab } from "./TrackingTab";

const baseProps = {
  contextMode: "mentioned" as const,
  excludedAliases: [],
  surfaces: ["刹那", "セツナ"],
  readings: { 刹那: ["せつな"], セツナ: ["せつな"] },
  onContextModeChange: vi.fn(),
  onExcludedAliasesChange: vi.fn(),
  onReadingsChange: vi.fn(),
  onEstimateReadings: vi.fn(),
  estimatingReadings: false,
};

describe("TrackingTab Japanese reading gate", () => {
  it("shows complete name and alias reading management for Japanese projects", () => {
    render(<TrackingTab {...baseProps} showReadings />);
    expect(screen.getByText("刹那")).toBeInTheDocument();
    expect(screen.getByText("セツナ")).toBeInTheDocument();
  });

  it("hides reading management for non-Japanese projects", () => {
    render(<TrackingTab {...baseProps} showReadings={false} />);
    expect(screen.queryByText("刹那")).not.toBeInTheDocument();
    expect(screen.queryByText("セツナ")).not.toBeInTheDocument();
    expect(screen.getByTestId("context-mode-selector")).toBeInTheDocument();
  });
});
