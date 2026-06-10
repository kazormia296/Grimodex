import { describe, it, expect } from "vitest";
import type { ImportSource, MarkdownImportMode } from "./importTypes";
import { defaultImportTarget } from "./importTarget";

/** Mirror ImportDialog top-level source tabs. */
function topLevelSources(): ImportSource[] {
  return ["novelcrafter", "kakuyomu", "markdown", "novel"];
}

/** Mirror MarkdownImportFlow mode tab accept rules. */
function acceptForMarkdownMode(mode: MarkdownImportMode): string {
  return mode === "single" ? ".md,.markdown,text/markdown" : ".zip";
}

describe("ImportDialog source config", () => {
  it("exposes four top-level source tabs including unified markdown", () => {
    expect(topLevelSources()).toEqual([
      "novelcrafter",
      "kakuyomu",
      "markdown",
      "novel",
    ]);
  });

  it("maps markdown mode sub-tabs to file accept attributes", () => {
    expect(acceptForMarkdownMode("single")).toContain(".md");
    expect(acceptForMarkdownMode("multi")).toBe(".zip");
  });

  it("defaults import target by source and markdown mode", () => {
    expect(defaultImportTarget("novelcrafter")).toBe("newProject");
    expect(defaultImportTarget("kakuyomu")).toBe("newProject");
    expect(defaultImportTarget("markdown", "single")).toBe("currentProject");
    expect(defaultImportTarget("markdown", "multi")).toBe("newProject");
    expect(defaultImportTarget("novel")).toBe("newProject");
  });
});
