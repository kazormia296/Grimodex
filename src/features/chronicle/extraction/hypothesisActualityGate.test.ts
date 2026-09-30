import { describe, expect, it } from "vitest";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type {
  EventObservationActuality,
  RawChronicleEventObservation,
} from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { checkHypothesisActuality } from "./hypothesisActualityGate";
import { synthesizeHypothesesFromClusters } from "./eventSynthesisFallback";

function observation(
  actuality: EventObservationActuality,
  localId = "obs",
): RawChronicleEventObservation {
  return {
    localId,
    evidence: [{ sourceRef: "S1", quote: "塔が崩れる" }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      predicate: "塔が崩れる",
      actuality,
      participants: [],
      temporalExpressions: [],
      durationKind: "unknown",
    },
  };
}

function hypothesis(
  observationRefs: readonly string[] = ["obs"],
  actuality: EventHypothesis["actuality"] = "actual",
): EventHypothesis {
  return {
    hypothesisId: "hyp",
    clusterRef: "cluster",
    observationRefs,
    titleSuggestion: "塔が崩れる",
    summary: "塔が崩れる",
    actuality,
    significance: "major",
  };
}

describe("checkHypothesisActuality", () => {
  it.each([
    "planned",
    "intended",
    "attempted",
    "prevented",
    "hypothetical",
    "counterfactual",
    "dreamed",
    "rumored",
    "unknown",
  ] as const)(
    "rejects an actual hypothesis supported only by %s",
    (actuality) => {
      const source = observation(actuality);
      const inference = hypothesis();
      const before = structuredClone({ source, inference });
      expect(checkHypothesisActuality(inference, [source])).toEqual({
        ok: false,
        reason: "hypothesis-observation-actuality-mismatch",
      });
      expect({ source, inference }).toEqual(before);
    },
  );

  it.each(["actual", "attempted", "prevented", "rumored"] as const)(
    "accepts supported %s without rewriting it",
    (actuality) => {
      expect(
        checkHypothesisActuality(hypothesis(["obs"], actuality), [
          observation(actuality),
        ]),
      ).toEqual({ ok: true });
    },
  );

  it.each(["rumored", "planned", "dreamed"] as const)(
    "rejects mixed actual and %s in either reference or storage order while accepting an independently supported hypothesis",
    (actuality) => {
      const rows = [
        observation("actual", "actual"),
        observation(actuality, "nonactual"),
      ];
      for (const observations of [rows, [...rows].reverse()]) {
        for (const refs of [
          ["actual", "nonactual"],
          ["nonactual", "actual"],
        ]) {
          expect(
            checkHypothesisActuality(hypothesis(refs), observations),
          ).toEqual({ ok: false, reason: "mixed-observation-actualities" });
        }
        expect(
          checkHypothesisActuality(hypothesis(["actual"]), observations),
        ).toEqual({ ok: true });
      }
    },
  );

  it("fails closed on incomplete and ambiguous references with stable reason precedence", () => {
    const rows = [observation("actual"), observation("rumored")];
    expect(checkHypothesisActuality(hypothesis([]), rows)).toEqual({
      ok: false,
      reason: "empty-observation-refs",
    });
    for (const observations of [rows, [...rows].reverse()]) {
      expect(checkHypothesisActuality(hypothesis(), observations)).toEqual({
        ok: false,
        reason: "ambiguous-observation-ref",
      });
      for (const refs of [
        ["obs", "missing"],
        ["missing", "obs"],
      ]) {
        expect(
          checkHypothesisActuality(hypothesis(refs), observations),
        ).toEqual({ ok: false, reason: "missing-observation-ref" });
      }
    }
  });
});

describe("deterministic synthesis actuality", () => {
  it.each(["rumored", "planned", "dreamed"] as const)(
    "records a mixed %s cluster rejection in either order and retains the independent actual cluster",
    (actuality) => {
      const rows = [
        observation("actual", "mixed-actual"),
        observation(actuality, "mixed-nonactual"),
        observation("actual", "control"),
      ];
      for (const observations of [rows, [...rows].reverse()]) {
        for (const refs of [
          ["mixed-actual", "mixed-nonactual"],
          ["mixed-nonactual", "mixed-actual"],
        ]) {
          const result = synthesizeHypothesesFromClusters(
            [
              { clusterRef: "mixed", observationRefs: refs },
              { clusterRef: "control", observationRefs: ["control"] },
            ],
            observations,
            () => "hyp-control",
          );
          expect(result.rejectedClusters).toEqual([
            { clusterRef: "mixed", reason: "mixed-observation-actualities" },
          ]);
          expect(result.hypotheses).toEqual([
            expect.objectContaining({
              hypothesisId: "hyp-control",
              clusterRef: "control",
              actuality: "actual",
              observationRefs: ["control"],
            }),
          ]);
        }
      }
    },
  );

  it.each(["planned", "dreamed"] as const)(
    "retains a reason when %s cannot form a supported hypothesis",
    (actuality) => {
      expect(
        synthesizeHypothesesFromClusters(
          [{ clusterRef: "cluster", observationRefs: ["obs"] }],
          [observation(actuality)],
          () => "hyp",
        ),
      ).toEqual({
        hypotheses: [],
        rejectedClusters: [
          { clusterRef: "cluster", reason: "unsupported-hypothesis-actuality" },
        ],
      });
    },
  );
});
