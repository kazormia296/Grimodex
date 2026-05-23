// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import { useRegionSegments } from "./useRegionSegments";

describe("useRegionSegments", () => {
  it("shows active panel on stripe when slot is open but panel is hidden", () => {
    const layout = buildDefaultLayoutState({ allInactive: true });
    layout.regions.left.slots = [
      {
        id: "l0",
        sizeRatio: 1,
        panels: ["scenes"],
        activePanel: null,
      },
      {
        id: "l1",
        sizeRatio: 1,
        panels: ["codex-quick"],
        activePanel: "codex-quick",
      },
    ];

    useLayoutStore.setState({
      layout,
      hiddenStripePanels: new Set(["codex-quick"]),
    });

    const { result } = renderHook(() => useRegionSegments());
    const leftCodexQuick = result.current.left
      .flatMap((segment) => segment.panels)
      .find((panel) => panel.id === "codex-quick");

    expect(leftCodexQuick).toEqual({
      id: "codex-quick",
      active: true,
    });
  });

  it("shows active bottom panel on stripe when all slot panels are hidden", () => {
    const layout = buildDefaultLayoutState({ allInactive: true });
    layout.regions.bottom.slots = [
      {
        id: "b0",
        sizeRatio: 1,
        panels: ["map", "grid", "matrix"],
        activePanel: "map",
      },
    ];

    useLayoutStore.setState({
      layout,
      hiddenStripePanels: new Set(["map", "grid", "matrix"]),
    });

    const { result } = renderHook(() => useRegionSegments());
    const bottomMap = result.current.bottom
      .flatMap((segment) => segment.panels)
      .find((panel) => panel.id === "map");

    expect(bottomMap).toEqual({ id: "map", active: true });
  });

  it("omits hidden panels from stripe when their slot is collapsed", () => {
    const layout = buildDefaultLayoutState({ allInactive: true });
    layout.regions.left.slots = [
      {
        id: "l1",
        sizeRatio: 1,
        panels: ["codex-quick"],
        activePanel: null,
      },
    ];

    useLayoutStore.setState({
      layout,
      hiddenStripePanels: new Set(["codex-quick"]),
    });

    const { result } = renderHook(() => useRegionSegments());
    expect(result.current.left).toEqual([]);
  });
});
