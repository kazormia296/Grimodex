import { describe, it, expect } from "vitest";
import type { ImportSource, MarkdownImportMode } from "./importTypes";

/** Mirror ImportDialog top-level source tabs. */
function topLevelSources(): ImportSource[] {
  return ["novelcrafter", "kakuyomu", "markdown"];
}

/** Mirror MarkdownImportFlow mode tab accept rules. */
function acceptForMarkdownMode(mode: MarkdownImportMode): string {
  return mode === "single" ? ".md,.markdown,text/markdown" : ".zip";
}

describe("ImportDialog source config", () => {
  it("exposes three top-level source tabs including unified markdown", () => {
    expect(topLevelSources()).toEqual(["novelcrafter", "kakuyomu", "markdown"]);
  });

  it("maps markdown mode sub-tabs to file accept attributes", () => {
    expect(acceptForMarkdownMode("single")).toContain(".md");
    expect(acceptForMarkdownMode("multi")).toBe(".zip");
  });
});
