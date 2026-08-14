import { describe, expect, it } from "vitest";

import { validateEvidencePolicy } from "./evidencePolicy";

describe("narrative evidence policy", () => {
  it("rejects inference without evidence", () => {
    expect(
      validateEvidencePolicy({
        producerKind: "ai-inference",
        supportClass: "single-source-inference",
        evidenceSet: [],
        sourceBasis: ["scene:1@revision:1"],
      }),
    ).toEqual({
      valid: false,
      reason: "evidence-required",
    });
  });

  it("allows an author declaration without evidence when its source basis exists", () => {
    expect(
      validateEvidencePolicy({
        producerKind: "author-declaration",
        supportClass: "author-declared",
        evidenceSet: [],
        sourceBasis: ["codex:1@revision:2"],
        evidenceAbsenceReason: "author-declaration",
      }),
    ).toEqual({ valid: true });
  });

  it("requires an explicit absence reason for legacy migration", () => {
    expect(
      validateEvidencePolicy({
        producerKind: "legacy-migration",
        supportClass: "legacy-unbound",
        evidenceSet: [],
        sourceBasis: ["legacy:1@revision:1"],
      }),
    ).toEqual({
      valid: false,
      reason: "evidence-absence-reason-required",
    });

    expect(
      validateEvidencePolicy({
        producerKind: "legacy-migration",
        supportClass: "legacy-unbound",
        evidenceSet: [],
        sourceBasis: ["legacy:1@revision:1"],
        evidenceAbsenceReason: "legacy-unbound",
      }),
    ).toEqual({ valid: true });
  });
});
