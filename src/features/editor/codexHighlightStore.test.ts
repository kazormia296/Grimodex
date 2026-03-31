import { describe, it, expect, beforeEach } from "vitest";
import { useCodexHighlightStore } from "./codexHighlightStore";

describe("codexHighlightStore", () => {
  beforeEach(() => {
    useCodexHighlightStore.setState({ matchTargets: [], hoveredEntryId: null });
  });

  it("sets match targets", () => {
    const targets = [{ id: 1, name: "太郎", type: "character" }];
    useCodexHighlightStore.getState().setMatchTargets(targets);
    expect(useCodexHighlightStore.getState().matchTargets).toEqual(targets);
  });

  it("sets hovered entry id", () => {
    useCodexHighlightStore.getState().setHoveredEntryId(42);
    expect(useCodexHighlightStore.getState().hoveredEntryId).toBe(42);
  });

  it("clears hovered entry id", () => {
    useCodexHighlightStore.getState().setHoveredEntryId(42);
    useCodexHighlightStore.getState().setHoveredEntryId(null);
    expect(useCodexHighlightStore.getState().hoveredEntryId).toBeNull();
  });
});
