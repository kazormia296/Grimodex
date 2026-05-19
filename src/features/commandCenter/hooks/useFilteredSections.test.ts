import { describe, expect, it } from "vitest";
import { filterSections } from "./useFilteredSections";
import type {
  CommandCenterItem,
  CommandCenterSection,
  ItemKind,
} from "../providers/types";

function item(id: string, kind: ItemKind): CommandCenterItem {
  return { id, kind, title: id, onSelect: () => {} };
}

const lexicalAll: CommandCenterSection = {
  id: "lexical",
  title: "Lexical",
  order: 1,
  items: [
    item("scene-1", "lexical-scene"),
    item("codex-1", "lexical-codex"),
    item("snippet-1", "lexical-snippet"),
  ],
};

const semantic: CommandCenterSection = {
  id: "semantic",
  title: "Semantic",
  order: 2,
  items: [item("chunk-1", "semantic-chunk")],
};

describe("filterSections (exclude semantics)", () => {
  it("returns all sections when no excludes", () => {
    expect(filterSections([lexicalAll, semantic], [], [])).toEqual([
      lexicalAll,
      semantic,
    ]);
  });

  it("excludedTypes=['lexical'] drops lexical section", () => {
    expect(
      filterSections([lexicalAll, semantic], [], ["lexical"]).map((s) => s.id),
    ).toEqual(["semantic"]);
  });

  it("excludedTypes=['semantic'] drops semantic section", () => {
    expect(
      filterSections([lexicalAll, semantic], [], ["semantic"]).map((s) => s.id),
    ).toEqual(["lexical"]);
  });

  it("excludedSources=['scene'] drops lexical-scene items AND the semantic section", () => {
    const result = filterSections([lexicalAll, semantic], ["scene"], []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("lexical");
    expect(result[0].items.map((i) => i.kind)).toEqual([
      "lexical-codex",
      "lexical-snippet",
    ]);
  });

  it("excludedSources=['codex'] drops only lexical-codex; semantic stays", () => {
    const result = filterSections([lexicalAll, semantic], ["codex"], []);
    expect(result).toHaveLength(2);
    expect(result[0].items.map((i) => i.kind)).toEqual([
      "lexical-scene",
      "lexical-snippet",
    ]);
    expect(result[1].id).toBe("semantic");
  });

  it("excludedSources=['snippet'] drops only lexical-snippet; semantic stays", () => {
    const result = filterSections([lexicalAll, semantic], ["snippet"], []);
    expect(result).toHaveLength(2);
    expect(result[0].items.map((i) => i.kind)).toEqual([
      "lexical-scene",
      "lexical-codex",
    ]);
    expect(result[1].id).toBe("semantic");
  });

  it("excludedSources covering all lexical kinds drops the lexical section entirely", () => {
    const result = filterSections(
      [lexicalAll, semantic],
      ["scene", "codex", "snippet"],
      [],
    );
    // scene exclude drops semantic too → only "nothing remains" → empty array
    expect(result).toEqual([]);
  });

  it("combines source + type excludes (AND)", () => {
    // exclude semantic type AND scene source → lexical without scenes
    const result = filterSections(
      [lexicalAll, semantic],
      ["scene"],
      ["semantic"],
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("lexical");
    expect(result[0].items.map((i) => i.kind)).toEqual([
      "lexical-codex",
      "lexical-snippet",
    ]);
  });
});
