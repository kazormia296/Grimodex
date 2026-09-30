import { describe, expect, it } from "vitest";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import {
  assertUniqueObservationLocalIds,
  rekeyObservationsForWindow,
} from "./windowExtractor";

function observation(
  localId: string,
  sourceRef: string,
  predicate: string,
): RawChronicleEventObservation {
  return {
    localId,
    evidence: [{ sourceRef, quote: predicate }],
    assertion: {
      attribution: "narrator",
      narrativeFrame: "story-world",
    },
    payload: {
      predicate,
      actuality: "actual",
      participants: [],
      temporalExpressions: [],
      durationKind: "instant",
    },
  };
}

describe("rekeyObservationsForWindow", () => {
  it("makes duplicate model localIds unique across windows", () => {
    const windowA = rekeyObservationsForWindow("window-001", [
      observation("obs-1", "S0001", "塔が崩れた"),
      observation("obs-2", "S0001", "兵士が避難した"),
    ]);
    const windowB = rekeyObservationsForWindow("window-002", [
      observation("obs-1", "S0002", "門が倒れた"),
    ]);

    const collected = [...windowA, ...windowB];
    expect(collected.map((item) => item.localId)).toEqual([
      "window-001:obs-001",
      "window-001:obs-002",
      "window-002:obs-001",
    ]);
    expect(() => assertUniqueObservationLocalIds(collected)).not.toThrow();
  });

  it("does not trust model localId as the global id", () => {
    const [rekeyed] = rekeyObservationsForWindow("window-003", [
      observation("custom-id", "S0001", "塔が崩れた"),
    ]);
    expect(rekeyed?.localId).toBe("window-003:obs-001");
  });

  it("throws when duplicate localIds remain after collection", () => {
    expect(() =>
      assertUniqueObservationLocalIds([
        observation("obs-1", "S0001", "塔が崩れた"),
        observation("obs-1", "S0002", "門が倒れた"),
      ]),
    ).toThrow(/Duplicate observation localId/);
  });
});
