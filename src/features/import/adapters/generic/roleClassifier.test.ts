import { describe, expect, it } from "vitest";
import { classifyResourceRole } from "./roleClassifier";

describe("roleClassifier", () => {
  it("classifies markdown under chapters/ as manuscript", () => {
    const resolution = classifyResourceRole({
      resourceKey: "ch1",
      relativePath: "chapters/01-opening.md",
      kind: "markdown",
      structuredData: undefined,
    });
    expect(resolution.role).toBe("manuscript");
    expect(resolution.disposition).toBe("import-and-extract");
  });

  it("classifies character CSV by headers", () => {
    const resolution = classifyResourceRole({
      resourceKey: "codex",
      relativePath: "data/characters.csv",
      kind: "table",
      structuredData: { headers: ["name", "role"], rows: [] },
    });
    expect(resolution.role).toBe("character-reference");
    expect(resolution.disposition).toBe("extract-structure-only");
  });

  it("classifies assets/ prefix as attachment ignore", () => {
    const resolution = classifyResourceRole({
      resourceKey: "img",
      relativePath: "assets/cover.png",
      kind: "binary",
      structuredData: undefined,
    });
    expect(resolution.role).toBe("attachment");
    expect(resolution.disposition).toBe("ignore");
  });
});
