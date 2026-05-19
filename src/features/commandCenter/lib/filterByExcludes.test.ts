import { describe, expect, it } from "vitest";
import { filterByExcludes } from "./filterByExcludes";
import type {
  CommandCenterItem,
  CommandCenterSection,
} from "../providers/types";

function item(id: string, title: string, subtitle?: string): CommandCenterItem {
  return {
    id,
    kind: "lexical-scene",
    title,
    subtitle,
    onSelect: () => {},
  };
}

function section(items: CommandCenterItem[]): CommandCenterSection {
  return { id: "test", title: "T", order: 1, items };
}

describe("filterByExcludes", () => {
  it("returns section unchanged when no excludes given", () => {
    const s = section([item("a", "Foo")]);
    expect(filterByExcludes(s, [])).toBe(s);
  });

  it("returns section unchanged when excludes are all empty strings", () => {
    const s = section([item("a", "Foo")]);
    expect(filterByExcludes(s, ["", "   ".trim()])).toBe(s);
  });

  it("filters items whose title contains an excluded word", () => {
    const s = section([
      item("a", "邂逅の朝"),
      item("b", "雨の夜"),
      item("c", "邂逅と雨"),
    ]);
    const result = filterByExcludes(s, ["雨"]);
    expect(result.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("filters items whose subtitle contains an excluded word", () => {
    const s = section([
      item("a", "scene1", "通常の朝"),
      item("b", "scene2", "雨が降る"),
    ]);
    const result = filterByExcludes(s, ["雨"]);
    expect(result.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("is case-insensitive", () => {
    const s = section([item("a", "Hello World"), item("b", "Foo bar")]);
    const result = filterByExcludes(s, ["WORLD"]);
    expect(result.items.map((i) => i.id)).toEqual(["b"]);
  });

  it("filters when ANY exclude matches (OR)", () => {
    const s = section([
      item("a", "X"),
      item("b", "X with foo"),
      item("c", "X with bar"),
      item("d", "X with foo and bar"),
    ]);
    const result = filterByExcludes(s, ["foo", "bar"]);
    expect(result.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("preserves section title/order/state when filtering", () => {
    const s: CommandCenterSection = {
      id: "lexical",
      title: "字句検索",
      order: 1,
      items: [item("a", "Foo")],
      state: { kind: "idle" },
    };
    const result = filterByExcludes(s, ["foo"]);
    expect(result.id).toBe("lexical");
    expect(result.title).toBe("字句検索");
    expect(result.order).toBe(1);
    expect(result.state).toEqual({ kind: "idle" });
    expect(result.items).toEqual([]);
  });
});
