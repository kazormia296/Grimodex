import { describe, it, expect } from "vitest";
import { defaultRubyStyle } from "./types";

describe("defaultRubyStyle", () => {
  it("plaintext defaults to parentheses", () => {
    expect(defaultRubyStyle("plaintext")).toBe("parentheses");
  });

  it("markdown defaults to html", () => {
    expect(defaultRubyStyle("markdown")).toBe("html");
  });

  it("html defaults to html", () => {
    expect(defaultRubyStyle("html")).toBe("html");
  });
});
