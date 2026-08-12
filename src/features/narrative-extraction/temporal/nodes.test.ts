import { describe, expect, it } from "vitest";
import {
  isSemanticFingerprint,
  isTemporalNodeId,
  temporalSubjectKey,
} from "./nodes";

describe("temporal node identity", () => {
  it("accepts only prefixed node ids and sealed semantic fingerprints", () => {
    expect(isTemporalNodeId("tn:scene-one")).toBe(true);
    expect(isTemporalNodeId("scene-one")).toBe(false);
    expect(isTemporalNodeId("tn:")).toBe(false);
    expect(isTemporalNodeId("tn:   ")).toBe(false);

    expect(isSemanticFingerprint(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isSemanticFingerprint(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isSemanticFingerprint("sha256:short")).toBe(false);
  });

  it("keeps multiple temporal segments of one Scene distinct", () => {
    expect(
      temporalSubjectKey({ kind: "scene", documentRef: "D000001" }),
    ).not.toBe(
      temporalSubjectKey({
        kind: "scene",
        documentRef: "D000001",
        segmentRef: "flashback-1",
      }),
    );
    expect(
      temporalSubjectKey({
        kind: "scene",
        documentRef: "D000001",
        segmentRef: "flashback-1",
      }),
    ).not.toBe(
      temporalSubjectKey({
        kind: "scene",
        documentRef: "D000001",
        segmentRef: "flashback-2",
      }),
    );
  });
});
