import { describe, expect, it } from "vitest";

import { parseRawChronicleEventObservationIdList } from "./schemas";

const claim = {
  localId: "obs-1",
  evidenceRefs: ["Erequest-001"],
  assertion: { attribution: "narrator", narrativeFrame: "story-world" },
  payload: {
    predicate: "扉が開いた",
    actuality: "actual",
    participants: [],
    temporalExpressions: [],
    durationKind: "instant",
  },
} as const;

describe("chronicle observation citation-ID schema", () => {
  it("accepts evidenceRefs-only output", () => {
    const result = parseRawChronicleEventObservationIdList({
      observations: [claim],
    });

    expect(result).toEqual({ ok: true, value: [claim] });
  });

  it("rejects model-written quotes, ranges, and legacy evidence in ID mode", () => {
    const result = parseRawChronicleEventObservationIdList({
      observations: [
        {
          ...claim,
          evidence: [{ sourceRef: "E000001", quote: "扉が開いた" }],
        },
        {
          ...claim,
          localId: "obs-2",
          range: { start: 0, end: 5 },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/unknown|evidence|range/i);
  });

  it("rejects empty and duplicate evidence refs", () => {
    const result = parseRawChronicleEventObservationIdList({
      observations: [
        { ...claim, evidenceRefs: ["", "Erequest-001", "Erequest-001"] },
      ],
    });

    expect(result.ok).toBe(false);
  });
});
