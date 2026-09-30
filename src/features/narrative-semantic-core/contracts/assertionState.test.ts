import { describe, expect, it } from "vitest";

import {
  createNarrativeAssertionState,
  isNarrativeAssertionState,
} from "./assertionState";

describe("narrative assertion state", () => {
  it("stores review and evidence freshness without projection state", () => {
    const state = createNarrativeAssertionState({
      revisionId: "revision-1",
      review: "accepted",
      evidenceFreshness: "fresh",
    });

    expect(state).toEqual({
      revisionId: "revision-1",
      review: "accepted",
      evidenceFreshness: "fresh",
    });
    expect(isNarrativeAssertionState(state)).toBe(true);
    expect("projection" in state).toBe(false);
  });

  it("does not require a stable assertion id for the first retrieval slice", () => {
    const state = createNarrativeAssertionState({
      revisionId: "revision-1",
      review: "unreviewed",
      evidenceFreshness: "unknown",
    });

    expect(state.revisionId).toBe("revision-1");
  });
});
