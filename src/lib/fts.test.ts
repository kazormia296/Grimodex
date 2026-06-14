import { describe, it, expect } from "vitest";
import {
  tokenizeFtsQuery,
  codepointLength,
  ftsOrMatch,
  toFtsMatchQuery,
} from "./fts";

describe("tokenizeFtsQuery", () => {
  it("splits on whitespace and drops empties", () => {
    expect(tokenizeFtsQuery("  iron   crown  ")).toEqual(["iron", "crown"]);
    expect(tokenizeFtsQuery("")).toEqual([]);
    expect(tokenizeFtsQuery("   ")).toEqual([]);
  });
});

describe("codepointLength", () => {
  it("counts surrogate pairs as one", () => {
    expect(codepointLength("ab")).toBe(2);
    expect(codepointLength("👍")).toBe(1);
  });
});

describe("ftsOrMatch", () => {
  it("quotes each token and joins with OR", () => {
    expect(ftsOrMatch(["iron", "crown"])).toBe('"iron" OR "crown"');
  });
  it("escapes embedded double quotes", () => {
    expect(ftsOrMatch(['"hi"'])).toBe('"""hi"""');
  });
});

describe("toFtsMatchQuery", () => {
  it("neutralizes FTS5 operators (comma / hyphen) instead of erroring", () => {
    // Raw "come back, with a final" used to raise: fts5: syntax error near ","
    expect(toFtsMatchQuery("come back, with a final")).toBe(
      '"come" OR "back," OR "with" OR "final"',
    );
    // Raw "the keeping-room door" used to raise: no such column: room
    expect(toFtsMatchQuery("the keeping-room door")).toBe(
      '"the" OR "keeping-room" OR "door"',
    );
  });

  it("drops tokens shorter than 3 codepoints", () => {
    expect(toFtsMatchQuery("a of in")).toBe("");
    expect(toFtsMatchQuery("a lock")).toBe('"lock"');
  });

  it("returns empty for blank input (caller falls back to LIKE)", () => {
    expect(toFtsMatchQuery("")).toBe("");
    expect(toFtsMatchQuery("   ")).toBe("");
  });
});
