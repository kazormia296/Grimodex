// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildSourceUri, parseSourceUri, titleFromFilename } from "./sourceUri";

describe("sourceUri", () => {
  it("round-trips external root URIs", () => {
    const uri = buildSourceUri("root-1", "chapter/01-intro.md");
    expect(parseSourceUri(uri)).toEqual({
      rootId: "root-1",
      relPath: "chapter/01-intro.md",
    });
  });

  it("strips numeric prefix from filenames", () => {
    expect(titleFromFilename("01-prologue.md")).toBe("prologue");
    expect(titleFromFilename("第一章.md")).toBe("第一章");
  });
});
