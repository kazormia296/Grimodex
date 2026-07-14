import { describe, it, expect } from "vitest";
import { deriveCellMap, type CellSource, type CellInfo } from "./deriveCells";

type MentionRow = {
  sceneId: string;
  codexEntryId: string;
  source: CellSource;
  role?: string;
};

describe("deriveCellMap", () => {
  it("returns empty map for empty mentions", () => {
    const map = deriveCellMap([]);
    expect(map.size).toBe(0);
  });

  it("maps (sceneId, codexEntryId) to CellInfo with topSource", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")?.topSource).toBe("body");
  });

  it("semantic > body > beat > relation priority in topSource", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "relation" },
      { sceneId: "s1", codexEntryId: "e1", source: "beat" },
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
      { sceneId: "s1", codexEntryId: "e1", source: "semantic" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")?.topSource).toBe("semantic");
  });

  it("preserves semantic as topSource regardless of insertion order", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "semantic" },
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
      { sceneId: "s1", codexEntryId: "e1", source: "beat" },
      { sceneId: "s1", codexEntryId: "e1", source: "relation" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")?.topSource).toBe("semantic");
  });

  it("collects all sources into sources set", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
      { sceneId: "s1", codexEntryId: "e1", source: "relation" },
      { sceneId: "s1", codexEntryId: "e1", source: "semantic" },
    ];
    const map = deriveCellMap(mentions);
    const info = map.get("s1::e1")!;
    expect(info.sources.has("body")).toBe(true);
    expect(info.sources.has("relation")).toBe(true);
    expect(info.sources.has("semantic")).toBe(true);
    expect(info.sources.has("beat")).toBe(false);
  });

  it("beat wins over relation in topSource", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "relation" },
      { sceneId: "s1", codexEntryId: "e1", source: "beat" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")?.topSource).toBe("beat");
  });

  it("relation alone yields relation topSource", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "relation" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")?.topSource).toBe("relation");
  });

  it("handles multiple scenes and entries independently", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
      { sceneId: "s1", codexEntryId: "e2", source: "beat" },
      { sceneId: "s2", codexEntryId: "e1", source: "relation" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")?.topSource).toBe("body");
    expect(map.get("s1::e2")?.topSource).toBe("beat");
    expect(map.get("s2::e1")?.topSource).toBe("relation");
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

  it("picks strongest role from beat rows (actor > target > mentioned)", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "beat", role: "target" },
      { sceneId: "s1", codexEntryId: "e1", source: "beat", role: "actor" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")?.role).toBe("actor");
  });

  it("defaults role to mentioned when no beat row", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
    ];
    const map = deriveCellMap(mentions);
    expect(map.get("s1::e1")?.role).toBe("mentioned");
  });

  it("CellInfo has expected shape", () => {
    const mentions: MentionRow[] = [
      { sceneId: "s1", codexEntryId: "e1", source: "body" },
    ];
    const map = deriveCellMap(mentions);
    const info: CellInfo = map.get("s1::e1")!;
    expect(info.topSource).toBe("body");
    expect(info.sources).toBeInstanceOf(Set);
    expect(typeof info.role).toBe("string");
  });
});
