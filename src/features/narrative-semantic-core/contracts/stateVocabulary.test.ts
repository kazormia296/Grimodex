import { describe, expect, it } from "vitest";

import {
  BUILD_ACTIONS,
  EVIDENCE_FRESHNESS_STATES,
  PROJECTION_APPLICATION_STATES,
  RECONCILIATION_SIGNALS,
  REVIEW_STATES,
  assertStateValueBelongsToAxis,
  isBuildAction,
  isEvidenceFreshness,
  isProjectionApplicationState,
  isReviewState,
} from "./stateVocabulary";

describe("narrative semantic state vocabulary", () => {
  it("keeps review, freshness, signal, action, and projection axes separate", () => {
    expect(isReviewState("accepted")).toBe(true);
    expect(isEvidenceFreshness("stale")).toBe(true);
    expect(isBuildAction("rebuild-required")).toBe(true);
    expect(isProjectionApplicationState("applied")).toBe(true);
    expect(isBuildAction("needs-reconciliation")).toBe(false);
    expect(isProjectionApplicationState("accepted")).toBe(false);
    expect(isReviewState("stale")).toBe(false);

    const axes = [
      REVIEW_STATES,
      EVIDENCE_FRESHNESS_STATES,
      RECONCILIATION_SIGNALS,
      BUILD_ACTIONS,
      PROJECTION_APPLICATION_STATES,
    ];
    const values = axes.flatMap((axis) => [...axis]);
    expect(new Set(values).size).toBe(values.length);
  });

  it("rejects a value used on the wrong axis", () => {
    expect(() => assertStateValueBelongsToAxis("accepted", "projection")).toThrow(
      /projection/i,
    );
    expect(() =>
      assertStateValueBelongsToAxis("needs-reconciliation", "build-action"),
    ).toThrow(/build-action/i);
  });
});
