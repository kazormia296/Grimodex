import { describe, expect, it } from "vitest";

import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { mergeObservationsByEvidence } from "./observationMerger";

function observation(
  sourceRef: string,
  quote: string,
  localId: string,
  predicate = localId,
): RawChronicleEventObservation {
  return {
    localId,
    evidence: [{ sourceRef, quote }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      predicate,
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

  it("retains distinct claims that cite the same sentence occurrence", () => {
    const merged = mergeObservationsByEvidence([
      observation("E000001", "同じ文。", "predicate-a", "扉が開いた"),
      observation("E000001", "同じ文。", "predicate-b", "兵が進んだ"),
    ]);

    expect(merged.map((entry) => entry.payload.predicate)).toEqual([
      "扉が開いた",
      "兵が進んだ",
    ]);
  });

  it("merges exact duplicate claims while ignoring localId", () => {
    const merged = mergeObservationsByEvidence([
      observation("E000001", "同じ文。", "window-a:obs-001", "扉が開いた"),
      observation("E000001", "同じ文。", "window-b:obs-004", "扉が開いた"),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.localId).toBe("window-a:obs-001");
  });

  it("retains repeated quotes from distinct catalog occurrences", () => {
    const merged = mergeObservationsByEvidence([
      observation("E000001", "同じ文。", "occurrence-a", "扉が開いた"),
      observation("E000002", "同じ文。", "occurrence-b", "扉が開いた"),
    ]);

    expect(merged.map((entry) => entry.evidence[0]?.sourceRef)).toEqual([
      "E000001",
      "E000002",
    ]);
  });

  it("keeps assertion, participants, actuality, and duration as claim identity", () => {
    const base = observation("E000001", "同じ文。", "base", "扉が開いた");
    const participantVariant: RawChronicleEventObservation = {
      ...base,
      localId: "participant-variant",
      payload: {
        ...base.payload,
        participants: [{ surface: "ミナ", role: "agent" }],
      },
    };
    const frameVariant: RawChronicleEventObservation = {
      ...base,
      localId: "frame-variant",
      assertion: { attribution: "unknown", narrativeFrame: "reported" },
    };
    const actualityVariant: RawChronicleEventObservation = {
      ...base,
      localId: "actuality-variant",
      payload: { ...base.payload, actuality: "planned" },
    };

    expect(
      mergeObservationsByEvidence([
        base,
        participantVariant,
        frameVariant,
        actualityVariant,
      ]),
    ).toHaveLength(4);
  });
});
