import { describe, it, expect } from "vitest";
import {
  normalizeUrl,
  fuzzyRatio,
  sanitizeCitations,
  findUnbackedUrls,
} from "./citationVerify";
import type { Citation } from "./agent/agentTypes";

const cite = (url: string, citedText = ""): Citation => ({
  url,
  title: "t",
  citedText,
});

describe("normalizeUrl", () => {
  it("strips www, trailing slash, query, and lowercases host", () => {
    expect(normalizeUrl("https://www.Example.com/Foo/")).toBe(
      "example.com/foo",
    );
    expect(normalizeUrl("https://example.com/foo?x=1#h")).toBe(
      "example.com/foo",
    );
  });
  it("returns lowercased trimmed input when unparseable", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("fuzzyRatio", () => {
  it("returns 1 for identical (case/space-insensitive) strings", () => {
    expect(fuzzyRatio("Hello World", "hello   world")).toBe(1);
  });
  it("returns 0 for no shared bigrams", () => {
    expect(fuzzyRatio("abc", "xyz")).toBe(0);
  });
  it("scores near-identical URLs >= 0.9", () => {
    expect(
      fuzzyRatio("example.com/article-2024", "example.com/article-2025"),
    ).toBeGreaterThanOrEqual(0.9);
  });
  it("scores unrelated hosts below 0.9", () => {
    expect(
      fuzzyRatio("example.com/edo", "totally-different.net/xyz"),
    ).toBeLessThan(0.9);
  });
});

describe("sanitizeCitations", () => {
  it("drops non-http(s) and unparseable URLs", () => {
    const out = sanitizeCitations([
      cite("https://ok.com/a"),
      cite("ftp://no.com/x"),
      cite("javascript:alert(1)"),
      cite("garbage"),
      cite(""),
    ]);
    expect(out.map((c) => c.url)).toEqual(["https://ok.com/a"]);
  });
  it("dedupes by normalized URL (www / trailing slash)", () => {
    const out = sanitizeCitations([
      cite("https://www.ex.com/p/"),
      cite("https://ex.com/p"),
      cite("https://ex.com/other"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].url).toBe("https://www.ex.com/p/");
    expect(out[1].url).toBe("https://ex.com/other");
  });
});

describe("findUnbackedUrls", () => {
  const citations = [cite("https://example.com/edo")];

  it("returns [] when all prose URLs are backed by citations", () => {
    const text = "出典: https://www.example.com/edo を参照。";
    expect(findUnbackedUrls(text, citations)).toEqual([]);
  });

  it("flags a prose URL not present in citations (fabricated)", () => {
    const text = "詳しくは https://fake-source.invalid/made-up を参照。";
    expect(findUnbackedUrls(text, citations)).toEqual([
      "https://fake-source.invalid/made-up",
    ]);
  });

  it("strips trailing punctuation before matching", () => {
    const text = "(https://example.com/edo).";
    expect(findUnbackedUrls(text, citations)).toEqual([]);
  });

  it("returns [] when there are no URLs in the answer", () => {
    expect(findUnbackedUrls("no links here", citations)).toEqual([]);
  });
});
