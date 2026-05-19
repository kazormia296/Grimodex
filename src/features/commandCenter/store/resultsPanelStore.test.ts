import { beforeEach, describe, expect, it } from "vitest";
import { useResultsPanelStore } from "./resultsPanelStore";

describe("useResultsPanelStore", () => {
  beforeEach(() => {
    useResultsPanelStore.setState({
      mounted: false,
      sourceFilter: "all",
      searchTypeFilter: "all",
      selectedItemId: null,
      hoveredItemId: null,
    });
  });

  it("setters update the corresponding field", () => {
    const s = useResultsPanelStore.getState();
    s.setMounted(true);
    s.setSourceFilter("codex");
    s.setSearchTypeFilter("semantic");
    s.setSelected("x");
    s.setHovered("y");
    const next = useResultsPanelStore.getState();
    expect(next.mounted).toBe(true);
    expect(next.sourceFilter).toBe("codex");
    expect(next.searchTypeFilter).toBe("semantic");
    expect(next.selectedItemId).toBe("x");
    expect(next.hoveredItemId).toBe("y");
  });

  it("reset() clears filters and selections but keeps mounted", () => {
    useResultsPanelStore.setState({
      mounted: true,
      sourceFilter: "scene",
      searchTypeFilter: "lexical",
      selectedItemId: "a",
      hoveredItemId: "b",
    });
    useResultsPanelStore.getState().reset();
    const s = useResultsPanelStore.getState();
    expect(s.mounted).toBe(true);
    expect(s.sourceFilter).toBe("all");
    expect(s.searchTypeFilter).toBe("all");
    expect(s.selectedItemId).toBeNull();
    expect(s.hoveredItemId).toBeNull();
  });
});
