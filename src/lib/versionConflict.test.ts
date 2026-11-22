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

  it("does not treat a replay refused because of a restore as a version conflict", () => {
    // The replay predates a project snapshot restore (Native, DR-SRC-9). It is
    // permanent, not a retryable CAS miss: the history must be cleared and the
    // error surfaced, not parked as a conflict the author could resolve.
    expect(
      isVersionConflictError(
        new Error(
          "NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE: the change being replayed predates a project snapshot restore and can no longer be undone or redone",
        ),
      ),
    ).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isVersionConflictError(new Error("boom"))).toBe(false);
  });
});
