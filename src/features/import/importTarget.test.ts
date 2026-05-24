import { describe, it, expect } from "vitest";
import { defaultImportTarget } from "./importTarget";

describe("defaultImportTarget", () => {
  it("defaults to new project for novelcrafter and kakuyomu", () => {
    expect(defaultImportTarget("novelcrafter")).toBe("newProject");
    expect(defaultImportTarget("kakuyomu")).toBe("newProject");
  });

  it("defaults to current project for single markdown and new project for multi", () => {
    expect(defaultImportTarget("markdown", "single")).toBe("currentProject");
    expect(defaultImportTarget("markdown", "multi")).toBe("newProject");
  });
});
