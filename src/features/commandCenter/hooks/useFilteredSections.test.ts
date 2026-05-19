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

describe("filterSections", () => {
  it("returns all sections when filters are 'all'", () => {
    expect(filterSections([lexicalAll, semantic], "all", "all")).toEqual([
      lexicalAll,
      semantic,
    ]);
  });

  it("searchTypeFilter=lexical drops semantic section", () => {
    const result = filterSections([lexicalAll, semantic], "all", "lexical");
    expect(result.map((s) => s.id)).toEqual(["lexical"]);
  });

  it("searchTypeFilter=semantic drops lexical section", () => {
    const result = filterSections([lexicalAll, semantic], "all", "semantic");
    expect(result.map((s) => s.id)).toEqual(["semantic"]);
  });

  it("sourceFilter=scene keeps lexical-scene only + semantic section", () => {
    const result = filterSections([lexicalAll, semantic], "scene", "all");
    expect(result).toHaveLength(2);
    expect(result[0].items.map((i) => i.kind)).toEqual(["lexical-scene"]);
    expect(result[1].id).toBe("semantic");
  });

  it("sourceFilter=codex keeps lexical-codex only and drops semantic", () => {
    const result = filterSections([lexicalAll, semantic], "codex", "all");
    expect(result).toHaveLength(1);
    expect(result[0].items.map((i) => i.kind)).toEqual(["lexical-codex"]);
  });

  it("sourceFilter=snippet keeps lexical-snippet only and drops semantic", () => {
    const result = filterSections([lexicalAll, semantic], "snippet", "all");
    expect(result).toHaveLength(1);
    expect(result[0].items.map((i) => i.kind)).toEqual(["lexical-snippet"]);
  });

  it("hides lexical section entirely when no item matches sourceFilter", () => {
    const onlyScenes: CommandCenterSection = {
      id: "lexical",
      title: "Lexical",
      order: 1,
      items: [item("scene-1", "lexical-scene")],
    };
    const result = filterSections([onlyScenes, semantic], "codex", "all");
    expect(result).toEqual([]); // both dropped
  });

  it("combines both filters via AND", () => {
    const result = filterSections([lexicalAll, semantic], "scene", "lexical");
    // lexical only + scenes only
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("lexical");
    expect(result[0].items.map((i) => i.kind)).toEqual(["lexical-scene"]);
  });
});
