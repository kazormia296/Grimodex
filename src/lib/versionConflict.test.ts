import { describe, it, expect } from "vitest";
import { isVersionConflictError } from "./versionConflict";

describe("isVersionConflictError", () => {
  it("detects journal restore version conflict", () => {
    expect(
      isVersionConflictError(
        new Error("codex entry 'e1' version 2 conflict during journal restore"),
      ),
    ).toBe(true);
  });

  it("detects codex CAS conflict message", () => {
    expect(
      isVersionConflictError(
        new Error(
          "Codex entry 'e1' version conflict: expected 1 but database has 3",
        ),
      ),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isVersionConflictError(new Error("boom"))).toBe(false);
  });
});
