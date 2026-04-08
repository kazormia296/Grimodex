import { describe, it, expect, beforeEach } from "vitest";
import { useCodexHighlightStore } from "./codexHighlightStore";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";

const c = (fg: string): ResolvedCodexColor => ({
  hl: fg + "29",
  tx: fg,
  fg,
});

describe("codexHighlightStore", () => {
  beforeEach(() => {
    useCodexHighlightStore.setState({
      matchTargets: [],
      hoveredEntryId: null,
      typeColorMap: {},
    });
  });

  it("sets match targets", () => {
    const targets = [{ id: "codex-1", name: "太郎", type: "character" }];
    useCodexHighlightStore.getState().setMatchTargets(targets);
    expect(useCodexHighlightStore.getState().matchTargets).toEqual(targets);
  });

  it("sets hovered entry id", () => {
    useCodexHighlightStore.getState().setHoveredEntryId("codex-42");
    expect(useCodexHighlightStore.getState().hoveredEntryId).toBe("codex-42");
  });

  it("clears hovered entry id", () => {
    useCodexHighlightStore.getState().setHoveredEntryId("codex-42");
    useCodexHighlightStore.getState().setHoveredEntryId(null);
    expect(useCodexHighlightStore.getState().hoveredEntryId).toBeNull();
  });

  it("sets type color map", () => {
    const map = {
      character: c("#7F77DD"),
      location: c("#1D9E75"),
    };
    useCodexHighlightStore.getState().setTypeColorMap(map);
    expect(useCodexHighlightStore.getState().typeColorMap).toEqual(map);
  });

  it("replaces type color map on update", () => {
    useCodexHighlightStore
      .getState()
      .setTypeColorMap({ character: c("#7F77DD") });
    useCodexHighlightStore
      .getState()
      .setTypeColorMap({ location: c("#1D9E75") });
    expect(useCodexHighlightStore.getState().typeColorMap).toEqual({
      location: c("#1D9E75"),
    });
  });
});
