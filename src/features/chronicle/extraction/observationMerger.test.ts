import { describe, expect, it } from "vitest";

import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { mergeObservationsByEvidence } from "./observationMerger";

function observation(
  sourceRef: string,
  quote: string,
  localId: string,
): RawChronicleEventObservation {
  return {
    localId,
    evidence: [{ sourceRef, quote }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      predicate: localId,
      actuality: "actual",
      participants: [],
      temporalExpressions: [],
      durationKind: "instant",
    },
  };
}

describe("mergeObservationsByEvidence", () => {
  it("does not merge distinct embedded-NUL evidence tuples", () => {
    const merged = mergeObservationsByEvidence([
      observation("a", "b\0c", "observation-a"),
      observation("a\0b", "c", "observation-b"),
    ]);

    expect(merged.map((entry) => entry.localId)).toEqual([
      "observation-a",
      "observation-b",
    ]);
  });
});
