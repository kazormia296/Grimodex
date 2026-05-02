import { describe, it, expect } from "vitest";
import { deriveColumns, type MatrixColumn } from "./deriveColumns";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";

type Entry = CodexMatchTarget & { tagsCache?: string | null };

function makeEntry(
  id: string,
  name: string,
  type: string,
  tags: string[] = [],
): Entry {
  return {
    id,
    name,
    type,
    aliases: [],
    excludedAliases: [],
    tagsCache: JSON.stringify(tags),
  };
}

describe("deriveColumns", () => {
  it("returns empty array for empty entries", () => {
    expect(deriveColumns([], "codex-all", [], false)).toEqual([]);
  });

  it("returns all entries for codex-all mode", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
      makeEntry("e3", "魔法陣", "lore"),
    ];
    const cols = deriveColumns(entries, "codex-all", [], false);
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toEqual(["e1", "e2", "e3"]);
  });

  it("filters by type for codex-characters mode", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
    ];
    const cols = deriveColumns(entries, "codex-characters", [], false);
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toEqual(["e1"]);
  });

  it("filters by type for codex-locations mode", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
    ];
    const cols = deriveColumns(entries, "codex-locations", [], false);
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toEqual(["e2"]);
  });

  it("applies tag filter (AND) when tagFilter is non-empty", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character", ["main", "hero"]),
      makeEntry("e2", "花子", "character", ["main"]),
      makeEntry("e3", "桐野", "character", ["sub"]),
    ];
    const cols = deriveColumns(
      entries,
      "codex-characters",
      ["main", "hero"],
      false,
    );
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toEqual(["e1"]);
  });

  it("returns all entries when tagFilter is empty", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character", ["main"]),
      makeEntry("e2", "花子", "character"),
    ];
    const cols = deriveColumns(entries, "codex-characters", [], false);
    expect(cols).toHaveLength(2);
  });

  it("groups by type when groupByType=true, adds section header columns", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
    ];
    const cols = deriveColumns(entries, "codex-all", [], true);
    const sectionCols = cols.filter((c) => c.isSectionHeader);
    expect(sectionCols.length).toBeGreaterThanOrEqual(2);
    const types = sectionCols.map((c) => c.sectionType);
    expect(types).toContain("character");
    expect(types).toContain("location");
  });

  it("does not add section headers when groupByType=false", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
    ];
    const cols = deriveColumns(entries, "codex-all", [], false);
    expect(cols.every((c) => !c.isSectionHeader)).toBe(true);
  });

  it("MatrixColumn has expected shape", () => {
    const entries: Entry[] = [makeEntry("e1", "太郎", "character")];
    const cols = deriveColumns(entries, "codex-all", [], false);
    const col = cols[0] as MatrixColumn;
    expect(col).toMatchObject({
      entry: expect.objectContaining({ id: "e1" }),
      isSectionHeader: false,
    });
  });

  // Phase B: new Show modes
  it("pov mode returns only character entries", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
      makeEntry("e3", "魔法陣", "lore"),
    ];
    const cols = deriveColumns(entries, "pov", [], false);
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toEqual(["e1"]);
  });

  it("location mode returns only location entries", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
    ];
    const cols = deriveColumns(entries, "location", [], false);
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toEqual(["e2"]);
  });

  it("subplot mode returns lore entries with matching subplot tag", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character", ["subplot"]),
      makeEntry("e2", "サブプロットA", "lore", ["subplot"]),
      makeEntry("e3", "世界設定", "lore", ["worldbuilding"]),
    ];
    const cols = deriveColumns(entries, "subplot", [], false, {
      subplotTagName: "subplot",
    });
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toEqual(["e2"]);
  });

  it("custom mode returns only entries in customEntryIds", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
      makeEntry("e3", "魔法陣", "lore"),
    ];
    const cols = deriveColumns(entries, "custom", [], false, {
      customEntryIds: ["e1", "e3"],
    });
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toEqual(["e1", "e3"]);
  });

  it("custom mode ignores tag filter", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character", ["main"]),
      makeEntry("e2", "廃社", "location"),
    ];
    // tagFilter ["main"] should NOT be applied in custom mode
    const cols = deriveColumns(entries, "custom", ["main"], false, {
      customEntryIds: ["e1", "e2"],
    });
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toEqual(["e1", "e2"]);
  });

  it("pov and location modes do not add section headers even when groupByType=true", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "花子", "character"),
    ];
    const cols = deriveColumns(entries, "pov", [], true);
    expect(cols.every((c) => !c.isSectionHeader)).toBe(true);
  });

  // Phase B-2: column operations
  it("pinnedColumnIds puts those entries first", () => {
    const entries: Entry[] = [
      makeEntry("e1", "A", "character"),
      makeEntry("e2", "B", "character"),
      makeEntry("e3", "C", "character"),
    ];
    const cols = deriveColumns(entries, "codex-all", [], false, {
      pinnedColumnIds: ["e3"],
    });
    const ids = cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id);
    expect(ids[0]).toBe("e3");
  });

  it("hiddenColumnIds removes those entries", () => {
    const entries: Entry[] = [
      makeEntry("e1", "A", "character"),
      makeEntry("e2", "B", "character"),
    ];
    const cols = deriveColumns(entries, "codex-all", [], false, {
      hiddenColumnIds: ["e2"],
    });
    const ids = cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id);
    expect(ids).toEqual(["e1"]);
    expect(ids).not.toContain("e2");
  });

  it("collapsedTypeSections removes entries for that type but keeps section header", () => {
    const entries: Entry[] = [
      makeEntry("e1", "A", "character"),
      makeEntry("e2", "B", "location"),
    ];
    const cols = deriveColumns(entries, "codex-all", [], true, {
      collapsedTypeSections: ["character"],
    });
    const sectionHeader = cols.find(
      (c) => c.isSectionHeader && c.sectionType === "character",
    );
    expect(sectionHeader).toBeDefined();
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).not.toContain("e1");
    expect(
      cols.filter((c) => !c.isSectionHeader).map((c) => c.entry!.id),
    ).toContain("e2");
  });
});
