import { describe, expect, it } from "vitest";
import { parseCommandInput } from "./parseCommandInput";

describe("parseCommandInput", () => {
  it("returns normal search text without excludes", () => {
    expect(parseCommandInput("邂逅")).toEqual({
      text: "邂逅",
      excludes: [],
    });
  });

  it("treats a leading > as ordinary search text", () => {
    expect(parseCommandInput(">cmd")).toEqual({
      text: ">cmd",
      excludes: [],
    });
    expect(parseCommandInput(">  do something")).toEqual({
      text: "> do something",
      excludes: [],
    });
  });

  it("keeps a standalone > as search text", () => {
    expect(parseCommandInput(">")).toEqual({
      text: ">",
      excludes: [],
    });
    expect(parseCommandInput("> ")).toEqual({
      text: ">",
      excludes: [],
    });
  });

  it("returns empty text for an empty string", () => {
    expect(parseCommandInput("")).toEqual({
      text: "",
      excludes: [],
    });
  });

  it("keeps embedded > in search text", () => {
    expect(parseCommandInput("foo>bar")).toEqual({
      text: "foo>bar",
      excludes: [],
    });
  });

  it("extracts -word tokens as excludes", () => {
    expect(parseCommandInput("邂逅 -雨")).toEqual({
      text: "邂逅",
      excludes: ["雨"],
    });
  });

  it("supports multiple excludes", () => {
    expect(parseCommandInput("foo -a -b baz -c")).toEqual({
      text: "foo baz",
      excludes: ["a", "b", "c"],
    });
  });

  it("combines leading > search text and excludes", () => {
    expect(parseCommandInput(">cmd -foo bar")).toEqual({
      text: ">cmd bar",
      excludes: ["foo"],
    });
  });

  it("returns empty text when only excludes are given", () => {
    expect(parseCommandInput("-only")).toEqual({
      text: "",
      excludes: ["only"],
    });
  });

  it("ignores standalone hyphen and double-dash tokens", () => {
    expect(parseCommandInput("foo - bar")).toEqual({
      text: "foo bar",
      excludes: [],
    });
    // `-` alone is not an exclude (length < 2)
  });
});
