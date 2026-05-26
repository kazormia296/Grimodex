import { beforeEach, describe, expect, it } from "vitest";
import { useResultsPanelStore } from "./resultsPanelStore";

describe("useResultsPanelStore", () => {
  beforeEach(() => {
    useResultsPanelStore.setState({
      excludedSources: [],
      excludedTypes: [],
      selectedItemId: null,
      hoveredItemId: null,
    });
  });

  it("setters update the corresponding field", () => {
    const s = useResultsPanelStore.getState();
    s.setSelected("x");
    s.setHovered("y");
    const next = useResultsPanelStore.getState();
    expect(next.selectedItemId).toBe("x");
    expect(next.hoveredItemId).toBe("y");
  });

  it("toggleSource: 含まれていれば除外配列に追加、再度トグルで除く", () => {
    const { toggleSource } = useResultsPanelStore.getState();
    toggleSource("scene");
    expect(useResultsPanelStore.getState().excludedSources).toEqual(["scene"]);
    toggleSource("codex");
    expect(useResultsPanelStore.getState().excludedSources).toEqual([
      "scene",
      "codex",
    ]);
    toggleSource("scene");
    expect(useResultsPanelStore.getState().excludedSources).toEqual(["codex"]);
  });

  it("toggleType: 同様にトグル動作", () => {
    const { toggleType } = useResultsPanelStore.getState();
    toggleType("lexical");
    toggleType("semantic");
    expect(useResultsPanelStore.getState().excludedTypes).toEqual([
      "lexical",
      "semantic",
    ]);
    toggleType("lexical");
    expect(useResultsPanelStore.getState().excludedTypes).toEqual(["semantic"]);
  });

  it("reset() clears filters and selections", () => {
    useResultsPanelStore.setState({
      excludedSources: ["scene", "codex"],
      excludedTypes: ["semantic"],
      selectedItemId: "a",
      hoveredItemId: "b",
    });
    useResultsPanelStore.getState().reset();
    const s = useResultsPanelStore.getState();
    expect(s.excludedSources).toEqual([]);
    expect(s.excludedTypes).toEqual([]);
    expect(s.selectedItemId).toBeNull();
    expect(s.hoveredItemId).toBeNull();
  });
});
