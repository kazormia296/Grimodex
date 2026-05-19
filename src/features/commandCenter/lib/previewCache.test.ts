import { describe, expect, it } from "vitest";
import { PreviewCache } from "./previewCache";
import type { LexicalPreviewContent } from "../preview/lexicalPreview";

function lex(s: string): LexicalPreviewContent {
  return { kind: "lexical", title: s, excerpt: s };
}

describe("PreviewCache (LRU)", () => {
  it("stores and retrieves values", () => {
    const c = new PreviewCache(3);
    c.set("a", lex("A"));
    expect(c.get("a")).toEqual(lex("A"));
    expect(c.has("a")).toBe(true);
    expect(c.size).toBe(1);
  });

  it("returns undefined for missing keys", () => {
    const c = new PreviewCache(3);
    expect(c.get("nope")).toBeUndefined();
  });

  it("evicts least recently used entry when capacity exceeded", () => {
    const c = new PreviewCache(2);
    c.set("a", lex("A"));
    c.set("b", lex("B"));
    c.set("c", lex("C")); // a should be evicted
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
    expect(c.has("c")).toBe(true);
  });

  it("get() promotes entry to most-recently-used", () => {
    const c = new PreviewCache(2);
    c.set("a", lex("A"));
    c.set("b", lex("B"));
    c.get("a"); // a is now MRU
    c.set("c", lex("C")); // b is LRU → evicted
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
    expect(c.has("c")).toBe(true);
  });

  it("set() on existing key replaces value and promotes to MRU", () => {
    const c = new PreviewCache(2);
    c.set("a", lex("A"));
    c.set("b", lex("B"));
    c.set("a", lex("A2")); // a now MRU
    c.set("c", lex("C")); // b LRU → evicted
    expect(c.get("a")).toEqual(lex("A2"));
    expect(c.has("b")).toBe(false);
  });

  it("clear() empties the cache", () => {
    const c = new PreviewCache(3);
    c.set("a", lex("A"));
    c.set("b", lex("B"));
    c.clear();
    expect(c.size).toBe(0);
    expect(c.has("a")).toBe(false);
  });
});
