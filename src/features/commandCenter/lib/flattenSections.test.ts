import { describe, expect, it } from "vitest";
import { flattenSections } from "./flattenSections";
import type {
  CommandCenterItem,
  CommandCenterSection,
} from "../providers/types";

function item(id: string): CommandCenterItem {
  return {
    id,
    kind: "lexical-scene",
    title: id,
    onSelect: () => {},
  };
}

function section(
  id: string,
  order: number,
  items: CommandCenterItem[],
): CommandCenterSection {
  return { id, title: id, order, items };
}

describe("flattenSections", () => {
  it("flattens sections in their array order", () => {
    const sections = [
      section("lexical", 1, [item("a"), item("b")]),
      section("semantic", 2, [item("c")]),
    ];
    expect(flattenSections(sections).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("skips empty sections", () => {
    const sections = [
      section("lexical", 1, [item("a")]),
      section("semantic", 2, []),
      section("commands", 3, [item("b")]),
    ];
    expect(flattenSections(sections).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("returns empty array when no sections", () => {
    expect(flattenSections([])).toEqual([]);
  });

  it("preserves the original item identity", () => {
    const a = item("a");
    const result = flattenSections([section("s", 1, [a])]);
    expect(result[0]).toBe(a);
  });
});
