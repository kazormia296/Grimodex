import { describe, expect, it } from "vitest";
import { parseCommandInput } from "./parseCommandInput";

describe("parseCommandInput", () => {
  it("treats normal text as search mode", () => {
    expect(parseCommandInput("邂逅")).toEqual({ mode: "search", text: "邂逅" });
  });

  it("treats > prefix as command mode and trims leading whitespace", () => {
    expect(parseCommandInput(">cmd")).toEqual({ mode: "command", text: "cmd" });
    expect(parseCommandInput(">  do something")).toEqual({
      mode: "command",
      text: "do something",
    });
  });

  it("returns empty text when only `>` is given", () => {
    expect(parseCommandInput(">")).toEqual({ mode: "command", text: "" });
    expect(parseCommandInput("> ")).toEqual({ mode: "command", text: "" });
  });

  it("treats empty string as search mode", () => {
    expect(parseCommandInput("")).toEqual({ mode: "search", text: "" });
  });

  it("does NOT treat embedded > as a mode switch", () => {
    expect(parseCommandInput("foo>bar")).toEqual({
      mode: "search",
      text: "foo>bar",
    });
  });
});
