import { describe, expect, it } from "vitest";
import { buildRelationCandidateIndex } from "./relationCandidateIndex";
import type { EntityRelationObservation } from "@/features/narrative-extraction/ir/observations/entityRelation";

function relationObs(
  localId: string,
  subjectLocal: string,
  objectLocal: string,
  predicate: string,
): EntityRelationObservation {
  return {
    localId,
    kind: "entity-relation",
    evidence: [{ sourceRef: "S0001", quote: predicate }],
    assertion: {
      attribution: "narrator",
      narrativeFrame: "story-world",
    },
    payload: {
      subject: { kind: "local", localId: subjectLocal },
      predicate,
      object: { kind: "local", localId: objectLocal },
      family: "social",
      mode: "holds",
    },
  };
}

describe("buildRelationCandidateIndex", () => {
  it("groups observations by resolved subject/object pair", () => {
    const index = buildRelationCandidateIndex(
      [
        relationObs("o1", "m1", "m2", "友人"),
        relationObs("o2", "m1", "m2", "盟友"),
        relationObs("o3", "m3", "m1", "師匠"),
      ],
      {
        resolveEntityId: (ref) => {
          if (ref.kind !== "local") return null;
          const map: Record<string, string> = {
            m1: "e1",
            m2: "e2",
            m3: "e3",
          };
          return map[ref.localId] ?? null;
        },
        createId: (() => {
          let n = 0;
          return () => `c${++n}`;
        })(),
      },
    );

    expect(index.entries).toHaveLength(2);
    const pair = index.entries.find(
      (entry) =>
        entry.subjectEntityId === "e1" && entry.objectEntityId === "e2",
    );
    expect(pair?.observationIds).toEqual(["o1", "o2"]);
    expect(pair?.predicates).toEqual(["友人", "盟友"]);
  });

  it("drops observations whose ends cannot be resolved", () => {
    const index = buildRelationCandidateIndex(
      [relationObs("o1", "m1", "unknown", "友人")],
      {
        resolveEntityId: (ref) =>
          ref.kind === "local" && ref.localId === "m1" ? "e1" : null,
      },
    );
    expect(index.entries).toEqual([]);
  });
});
