import { describe, it, expect } from "vitest";
import { deriveCellMap, type CellSource } from "./deriveCells";

type MentionRow = { sceneId: string; codexEntryId: string; source: CellSource };

describe("deriveCellMap", () => {
  it("returns empty map for empty mentions", () => {
    const map = deriveCellMap([]);
    expect(map.size).toBe(0);
  });

  it("maps (sceneId, codexEntryId) to strongest source", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")).toBe("body");
  });

  it("body > beat > relation priority", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "relation" },
      { sceneId: "s1", codexEntryId: "e1", source: "beat" },
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")).toBe("body");
  });

  it("beat wins over relation", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "relation" },
      { sceneId: "s1", codexEntryId: "e1", source: "beat" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")).toBe("beat");
  });

  it("relation alone yields relation source", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "relation" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")).toBe("relation");
  });

  it("handles multiple scenes and entries independently", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
      { sceneId: "s1", codexEntryId: "e2", source: "beat" },
      { sceneId: "s2", codexEntryId: "e1", source: "relation" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")).toBe("body");
    expect(map.get("s1::e2")).toBe("beat");
    expect(map.get("s2::e1")).toBe("relation");
  });

  it("counts total filled cells correctly", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
      { sceneId: "s1", codexEntryId: "e1", source: "beat" }, // same pair → 1 cell
      { sceneId: "s2", codexEntryId: "e1", source: "relation" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.size).toBe(2);
  });
});
