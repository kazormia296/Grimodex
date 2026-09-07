import { describe, expect, it } from "vitest";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import { planChronicleEventProposals } from "./proposalPlanner";

const DIGEST = `sha256:${"b".repeat(64)}` as Sha256Digest;

function observation(
  overrides: Partial<RawChronicleEventObservation> = {},
): RawChronicleEventObservation {
  return {
    localId: "obs-1",
    evidence: [{ sourceRef: "S0001", quote: "教会の尖塔が崩れ落ちた。" }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      predicate: "教会の尖塔が崩れ落ちた",
      actuality: "actual",
      participants: [{ surface: "ライカ", role: "witness" }],
      temporalExpressions: [],
      durationKind: "instant",
    },
    ...overrides,
  };
}

function hypothesis(overrides: Partial<EventHypothesis> = {}): EventHypothesis {
  return {
    hypothesisId: "hyp-1",
    clusterRef: "cluster-0001",
    observationRefs: ["obs-1"],
    titleSuggestion: "教会砲撃",
    summary: "教会が砲撃された",
    actuality: "actual",
    significance: "major",
    ...overrides,
  };
}

function anchor(
  overrides: Partial<ResolvedEvidenceAnchor> = {},
): ResolvedEvidenceAnchor {
  return {
    id: "anchor-0001",
    sourceRef: "S0001",
    documentRef: "D000001",
    quote: "教会の尖塔が崩れ落ちた。",
    canonicalRange: { start: 0, end: 12 },
    sourceRange: { start: 0, end: 12 },
    projection: {
      status: "exact",
      fragments: [
        {
          canonicalStart: 0,
          canonicalEnd: 12,
          from: 1,
          to: 13,
          kind: "linear",
        },
      ],
    },
    context: { prefix: "", suffix: "" },
    method: "exact",
    initialMatchCount: 1,
    quoteDigest: DIGEST,
    snapshotDigest: DIGEST,
    contentDigest: DIGEST,
    documentDigest: DIGEST,
    documentArtifactDigest: DIGEST,
    sourceDigest: DIGEST,
    ...overrides,
  };
}

describe("planChronicleEventProposals", () => {
  it("emits proposals for actual/major events with resolved evidence", () => {
    const planned = planChronicleEventProposals({
      hypotheses: [hypothesis()],
      observations: [observation()],
      anchors: [anchor()],
      matchesByHypothesisId: new Map([["hyp-1", { status: "none" }]]),
      createId: () => "event-1",
    });
    expect(planned).toHaveLength(1);
    expect(planned[0].proposal).toMatchObject({
      eventId: "event-1",
      title: "教会砲撃",
      actuality: "actual",
      significance: "major",
      evidenceAnchorIds: ["anchor-0001"],
      disclosure: { secret: true, revealDocumentRef: "D000001" },
    });
  });

  it("suppresses a rumored major hypothesis even with resolved evidence", () => {
    expect(
      planChronicleEventProposals({
        hypotheses: [hypothesis({ actuality: "rumored" })],
        observations: [observation()],
        anchors: [anchor()],
        matchesByHypothesisId: new Map([["hyp-1", { status: "none" }]]),
      }),
    ).toEqual([]);
  });

  it("skips planned / minor / unresolved-evidence / already-satisfied", () => {
    const planned = planChronicleEventProposals({
      hypotheses: [
        hypothesis({
          hypothesisId: "planned",
          actuality: "actual",
          significance: "minor",
        }),
        hypothesis({
          hypothesisId: "no-evidence",
          observationRefs: ["missing"],
        }),
        hypothesis({ hypothesisId: "satisfied" }),
      ],
      observations: [observation()],
      anchors: [anchor()],
      matchesByHypothesisId: new Map([
        ["planned", { status: "none" }],
        ["no-evidence", { status: "none" }],
        [
          "satisfied",
          { status: "already-satisfied", existingRef: "existing-1" },
        ],
      ]),
      createId: () => "event-x",
    });
    expect(planned).toEqual([]);
  });

  it("keeps probable-duplicate proposals for explicit review", () => {
    const planned = planChronicleEventProposals({
      hypotheses: [hypothesis()],
      observations: [observation()],
      anchors: [anchor()],
      matchesByHypothesisId: new Map([
        [
          "hyp-1",
          {
            status: "probable-duplicate",
            candidates: ["existing-1"],
            reasons: ["title-only"],
          },
        ],
      ]),
      createId: () => "event-dup",
    });
    expect(planned).toHaveLength(1);
    expect(planned[0].match.status).toBe("probable-duplicate");
  });

  it("keeps embedded-NUL evidence tuples bound to their own anchor", () => {
    const firstAnchor = anchor({
      id: "anchor-nul-a",
      sourceRef: "a",
      quote: "b\0c",
      documentRef: "document-nul-a",
    });
    const secondAnchor = anchor({
      id: "anchor-nul-b",
      sourceRef: "a\0b",
      quote: "c",
      documentRef: "document-nul-b",
    });
    const planned = planChronicleEventProposals({
      hypotheses: [hypothesis()],
      observations: [
        observation({
          evidence: [{ sourceRef: "a", quote: "b\0c" }],
        }),
      ],
      anchors: [firstAnchor, secondAnchor],
      matchesByHypothesisId: new Map([["hyp-1", { status: "none" }]]),
      createId: () => "event-nul",
    });

    expect(planned[0]?.proposal.evidenceAnchorIds).toEqual([firstAnchor.id]);
    expect(planned[0]?.proposal.evidenceDocumentRefs).toEqual([
      firstAnchor.documentRef,
    ]);
  });

  it("does not select an ambiguous duplicate evidence tuple", () => {
    const firstAnchor = anchor({ id: "anchor-duplicate-a" });
    const duplicateAnchor = anchor({
      id: "anchor-duplicate-b",
      documentRef: "document-duplicate-conflict",
    });
    const planned = planChronicleEventProposals({
      hypotheses: [hypothesis()],
      observations: [observation()],
      anchors: [firstAnchor, duplicateAnchor],
      matchesByHypothesisId: new Map([["hyp-1", { status: "none" }]]),
      createId: () => "event-duplicate",
    });

    expect(planned).toEqual([]);
  });
});
