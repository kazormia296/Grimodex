import { describe, expect, it } from "vitest";
import {
  chronicleScopeKey,
  isSameChronicleScope,
  type ChronicleScope,
} from "./chronicleScope";

const scope = (
  workspacePath: string,
  openRevision: number,
  projectId = "project",
): ChronicleScope => ({ workspacePath, openRevision, projectId });

describe("ChronicleScope", () => {
  it("workspace path, open revision, and project id all participate in identity", () => {
    const base = scope("/workspace/a", 7, "project");

    expect(
      isSameChronicleScope(base, scope("/workspace/a", 7, "project")),
    ).toBe(true);
    expect(
      isSameChronicleScope(base, scope("/workspace/b", 7, "project")),
    ).toBe(false);
    expect(
      isSameChronicleScope(base, scope("/workspace/a", 8, "project")),
    ).toBe(false);
    expect(isSameChronicleScope(base, scope("/workspace/a", 7, "other"))).toBe(
      false,
    );
    expect(isSameChronicleScope(base, null)).toBe(false);
    expect(isSameChronicleScope(null, null)).toBe(true);
  });

  it("builds an unambiguous key even when fields contain separator-like text", () => {
    expect(chronicleScopeKey(scope("/a\u0000b", 12, "p"))).not.toBe(
      chronicleScopeKey(scope("/a", 12, "b\u0000p")),
    );
    expect(chronicleScopeKey(scope("/a", 12, "p"))).toBe(
      chronicleScopeKey(scope("/a", 12, "p")),
    );
  });
});
