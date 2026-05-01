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
    expect(cols.map((c) => c.entry.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("filters by type for codex-characters mode", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
    ];
    const cols = deriveColumns(entries, "codex-characters", [], false);
    expect(cols.map((c) => c.entry.id)).toEqual(["e1"]);
  });

  it("filters by type for codex-locations mode", () => {
    const entries: Entry[] = [
      makeEntry("e1", "太郎", "character"),
      makeEntry("e2", "廃社", "location"),
    ];
    const cols = deriveColumns(entries, "codex-locations", [], false);
    expect(cols.map((c) => c.entry.id)).toEqual(["e2"]);
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
    expect(cols.map((c) => c.entry.id)).toEqual(["e1"]);
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
    const col: MatrixColumn = cols[0];
    expect(col).toMatchObject({
      entry: expect.objectContaining({ id: "e1" }),
      isSectionHeader: false,
    });
  });
});
