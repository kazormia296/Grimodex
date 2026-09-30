import { describe, expect, it } from "vitest";
import { normalizeEventSynthesis } from "./eventSynthesis";
import { parseRawChronicleEventObservation } from "./schemas";

describe("Chronicle actuality stage boundaries", () => {
  it.each(["rumored", "actual"])(
    "preserves %s independently of reported character attribution",
    (actuality) => {
      const observation = {
        localId: "o1",
        evidence: [
          { sourceRef: "S0001", quote: "The bridge collapsed, she said." },
        ],
        assertion: {
          attribution: "character:speaker",
          narrativeFrame: "reported",
        },
        payload: {
          predicate: "collapse",
          actuality,
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      };
      expect(parseRawChronicleEventObservation(observation)).toEqual({
        ok: true,
        value: observation,
      });
      const result = normalizeEventSynthesis(
        {
          clusterRef: "c1",
          resolution: "single-event",
          events: [
            {
              observationRefs: ["o1"],
              titleSuggestion: "Bridge collapse",
              summary: "The bridge collapsed",
              actuality,
              significance: "major",
            },
          ],
        },
        {
          clusterRef: "c1",
          allowedObservationRefs: new Set(["o1"]),
          createId: () => "h1",
        },
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ actuality, observationRefs: ["o1"] });
    },
  );

  it("does not widen synthesis to planned or unknown actuality", () => {
    for (const actuality of ["planned", "unknown", "invented"]) {
      expect(
        normalizeEventSynthesis(
          {
            clusterRef: "c1",
            resolution: "single-event",
            events: [
              {
                observationRefs: ["o1"],
                titleSuggestion: "Event",
                summary: "Event",
                actuality,
                significance: "major",
              },
            ],
          },
          { clusterRef: "c1", allowedObservationRefs: new Set(["o1"]) },
        ),
      ).toEqual([]);
    }
  });
});
