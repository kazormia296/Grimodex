import { describe, expect, it } from "vitest";
import { parseProposedContent } from "./prose";

describe("parseProposedContent", () => {
  it("parses JSON staging payload", () => {
    const raw = JSON.stringify({
      mode: "insert",
      text: "hello",
      replaceFrom: 1,
      replaceTo: 2,
    });
    expect(parseProposedContent(raw)).toEqual({
      mode: "insert",
      text: "hello",
      replaceFrom: 1,
      replaceTo: 2,
    });
  });

  it("falls back to append for plain text", () => {
    expect(parseProposedContent("legacy plain")).toEqual({
      mode: "append",
      text: "legacy plain",
    });
  });
});
