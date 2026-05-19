import { describe, expect, it } from "vitest";
import { parseCommandInput } from "./parseCommandInput";

describe("parseCommandInput", () => {
  it("treats normal text as search mode without excludes", () => {
    expect(parseCommandInput("邂逅")).toEqual({
      mode: "search",
      text: "邂逅",
      excludes: [],
    });
  });

  it("treats > prefix as command mode and trims leading whitespace", () => {
    expect(parseCommandInput(">cmd")).toEqual({
      mode: "command",
      text: "cmd",
      excludes: [],
    });
    expect(parseCommandInput(">  do something")).toEqual({
      mode: "command",
      text: "do something",
      excludes: [],
    });
  });

  it("returns empty text when only `>` is given", () => {
    expect(parseCommandInput(">")).toEqual({
      mode: "command",
      text: "",
      excludes: [],
    });
    expect(parseCommandInput("> ")).toEqual({
      mode: "command",
      text: "",
      excludes: [],
    });
  });

  it("treats empty string as search mode", () => {
    expect(parseCommandInput("")).toEqual({
      mode: "search",
      text: "",
      excludes: [],
    });
  });

  it("does NOT treat embedded > as a mode switch", () => {
    expect(parseCommandInput("foo>bar")).toEqual({
      mode: "search",
      text: "foo>bar",
      excludes: [],
    });
  });

  it("extracts -word tokens as excludes", () => {
    expect(parseCommandInput("邂逅 -雨")).toEqual({
      mode: "search",
      text: "邂逅",
      excludes: ["雨"],
    });
  });

  it("supports multiple excludes", () => {
    expect(parseCommandInput("foo -a -b baz -c")).toEqual({
      mode: "search",
      text: "foo baz",
      excludes: ["a", "b", "c"],
    });
  });

  it("combines > mode and excludes", () => {
    expect(parseCommandInput(">cmd -foo bar")).toEqual({
      mode: "command",
      text: "cmd bar",
      excludes: ["foo"],
    });
  });

  it("returns empty text when only excludes are given", () => {
    expect(parseCommandInput("-only")).toEqual({
      mode: "search",
      text: "",
      excludes: ["only"],
    });
  });

  it("ignores standalone hyphen and double-dash tokens", () => {
    expect(parseCommandInput("foo - bar")).toEqual({
      mode: "search",
      text: "foo bar",
      excludes: [],
    });
    // `-` alone is not an exclude (length < 2)
  });
});
