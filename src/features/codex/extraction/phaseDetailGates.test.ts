import { describe, expect, it } from "vitest";
import type { StateAssertionObservation } from "@/features/narrative-extraction/ir/observations/stateAssertion";
import type { NarrativeAssertionContext } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { classifyFacetDurability } from "@/features/narrative-extraction/ir/inferences/stateSupport";
import { buildStateObservationIndex } from "./stateObservationIndex";
import { buildStateTrackManifest } from "./stateTrackManifest";
import { synthesizeStateTracks } from "./stateTrackSynthesis";
import { detectStateTransitions } from "./transitionDetector";
import { buildPhaseBoundaryCandidates } from "./phaseBoundaryCandidates";
import {
  evaluatePhasePersistenceGate,
  synthesizePhaseBoundaries,
} from "./phaseBoundarySynthesis";
import {
  composeDetailValue,
  DetailComposeError,
  toPhaseDetailWrite,
} from "./detailValueComposer";
import { planPhaseAndDetailProposals } from "./phaseProposalPlanner";
import {
  createNewBindCodexPhaseProposal,
} from "@/features/narrative-extraction/proposals/bindCodexPhaseProposal";
import { createSetCodexBaseDetailProposal } from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";
import type { DetailDefinitionCatalogRecord } from "@/features/codex/details/detailDefinitionCatalog";
import type { DetailProjectionHypothesis } from "@/features/narrative-extraction/ir/inferences/detailProjection";

const ASSERTION: NarrativeAssertionContext = {
  attribution: "narrator",
  narrativeFrame: "story-world",
};

let seq = 0;
function obs(
  partial: Omit<StateAssertionObservation, "kind" | "evidence" | "assertion"> & {
    kind?: "state-assertion";
  },
): StateAssertionObservation {
  return {
    localId: partial.localId,
    kind: "state-assertion",
    evidence: [],
    assertion: ASSERTION,
    payload: partial.payload,
  };
}

function resolveLocal(ref: { kind: string; localId?: string; surface?: string }) {
  if (ref.kind === "local" && ref.localId) return ref.localId;
  return null;
}

describe("§37 State Track / Phase Gate / Detail Binding", () => {
  it("classifies transient emotion and scene location as transient", () => {
    expect(classifyFacetDurability("emotion.anger")).toBe("transient");
    expect(classifyFacetDurability("location.scene")).toBe("transient");
  });

  it("classifies durable injury and role as phase-worthy durability", () => {
    expect(classifyFacetDurability("injury.severe.arm")).toBe("major");
    expect(classifyFacetDurability("role.current")).toBe("major");
    expect(classifyFacetDurability("injury.bruise")).toBe("moderate");
  });

  it("does not create Phase candidates for transient emotion/location", () => {
    const observations = [
      obs({
        localId: "o1",
        payload: {
          subject: { kind: "local", localId: "ent:raika" },
          facetKey: "emotion.fear",
          aspect: "holds",
          value: { kind: "text", text: "恐れ" },
          temporalMode: "current",
          anchorDocumentRef: "S0001",
        },
      }),
      obs({
        localId: "o2",
        payload: {
          subject: { kind: "local", localId: "ent:raika" },
          facetKey: "location.scene",
          aspect: "changes",
          value: { kind: "text", text: "廊下" },
          temporalMode: "current",
          anchorDocumentRef: "S0001",
        },
      }),
    ];
    const index = buildStateObservationIndex(observations, {
      resolveEntityId: resolveLocal,
    });
    const manifest = buildStateTrackManifest(index, {
      createId: () => `m${++seq}`,
    });
    const tracks = synthesizeStateTracks(index, manifest, {
      createId: () => `t${++seq}`,
    });
    const transitions = detectStateTransitions(tracks, {
      createId: () => `tr${++seq}`,
    });
    const candidates = buildPhaseBoundaryCandidates(transitions, {
      createId: () => `c${++seq}`,
    });
    expect(candidates).toHaveLength(0);
  });

  it("promotes durable injury/role change to Phase candidates", () => {
    const observations = [
      obs({
        localId: "o1",
        payload: {
          subject: { kind: "local", localId: "ent:raika" },
          facetKey: "role.current",
          aspect: "holds",
          value: { kind: "enum", optionRef: "OPT_soldier" },
          temporalMode: "timeless",
          anchorDocumentRef: "S0001",
        },
      }),
      obs({
        localId: "o2",
        payload: {
          subject: { kind: "local", localId: "ent:raika" },
          facetKey: "role.current",
          aspect: "changes",
          value: { kind: "enum", optionRef: "OPT_captain" },
          temporalMode: "current",
          anchorDocumentRef: "S0002",
        },
      }),
    ];
    const index = buildStateObservationIndex(observations, {
      resolveEntityId: resolveLocal,
    });
    const manifest = buildStateTrackManifest(index, {
      createId: () => `m${++seq}`,
    });
    const tracks = synthesizeStateTracks(index, manifest, {
      createId: () => `t${++seq}`,
    });
    const transitions = detectStateTransitions(tracks, {
      createId: () => `tr${++seq}`,
    });
    const candidates = buildPhaseBoundaryCandidates(transitions, {
      createId: () => `c${++seq}`,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].entityId).toBe("ent:raika");
    expect(candidates[0].anchorDocumentRef).toBe("S0002");
  });

  it("consolidates same entity+anchor into one boundary candidate", () => {
    const observations = [
      obs({
        localId: "o1",
        payload: {
          subject: { kind: "local", localId: "ent:raika" },
          facetKey: "injury.bruise",
          aspect: "begins",
          value: { kind: "text", text: "打撲" },
          temporalMode: "current",
          anchorDocumentRef: "S0003",
        },
      }),
      obs({
        localId: "o2",
        payload: {
          subject: { kind: "local", localId: "ent:raika" },
          facetKey: "affiliation.unit",
          aspect: "changes",
          value: { kind: "text", text: "第三小隊" },
          temporalMode: "current",
          anchorDocumentRef: "S0003",
        },
      }),
    ];
    const index = buildStateObservationIndex(observations, {
      resolveEntityId: resolveLocal,
    });
    const manifest = buildStateTrackManifest(index, {
      createId: () => `m${++seq}`,
    });
    const tracks = synthesizeStateTracks(index, manifest, {
      createId: () => `t${++seq}`,
    });
    // Seed a prior value so detectStateTransitions emits changes
    const seeded = tracks.map((track) => ({
      ...track,
      payload: {
        ...track.payload,
        points: [
          {
            observationId: `${track.trackId}-prior`,
            value: { kind: "text" as const, text: "before" },
            temporalMode: "current" as const,
            anchorDocumentRef: "S0002",
            retrospectiveOnly: false,
            durability: track.payload.durability,
          },
          ...track.payload.points,
        ],
      },
    }));
    const transitions = detectStateTransitions(seeded, {
      createId: () => `tr${++seq}`,
    });
    const candidates = buildPhaseBoundaryCandidates(
      transitions.filter((t) => t.payload.anchorDocumentRef === "S0003"),
      { createId: () => `c${++seq}` },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].transitionIds.length).toBeGreaterThanOrEqual(2);
  });

  it("persistence gate: major durable alone → proposal", () => {
    const candidate = {
      candidateId: "c1",
      entityId: "ent:raika",
      anchorDocumentRef: "S0001",
      transitionIds: ["tr1"],
      transitions: [
        {
          transitionId: "tr1",
          observationRefs: ["o1"],
          payload: {
            entityId: "ent:raika",
            facetKey: "role.current",
            trackId: "t1",
            fromValue: { kind: "text" as const, text: "兵士" },
            toValue: { kind: "text" as const, text: "隊長" },
            magnitude: "major" as const,
            durability: "major" as const,
            anchorDocumentRef: "S0001",
            retrospectiveOnly: false,
          },
          epistemic: {
            polarity: "affirmed" as const,
            commitment: "story-fact" as const,
            support: "direct" as const,
            narrativeFrame: "primary" as const,
          },
        },
      ],
    };
    expect(evaluatePhasePersistenceGate(candidate)).toEqual({
      kind: "proposal",
      reason: "major-durable",
    });
  });

  it("persistence gate: single moderate → report-only; two moderate → proposal", () => {
    const one = {
      candidateId: "c1",
      entityId: "ent:raika",
      anchorDocumentRef: "S0001",
      transitionIds: ["tr1"],
      transitions: [
        {
          transitionId: "tr1",
          observationRefs: ["o1"],
          payload: {
            entityId: "ent:raika",
            facetKey: "injury.bruise",
            trackId: "t1",
            fromValue: null,
            toValue: { kind: "text" as const, text: "打撲" },
            magnitude: "moderate" as const,
            durability: "moderate" as const,
            anchorDocumentRef: "S0001",
            retrospectiveOnly: false,
          },
          epistemic: {
            polarity: "affirmed" as const,
            commitment: "story-fact" as const,
            support: "direct" as const,
            narrativeFrame: "primary" as const,
          },
        },
      ],
    };
    expect(evaluatePhasePersistenceGate(one).kind).toBe("report-only");

    const two = {
      ...one,
      transitionIds: ["tr1", "tr2"],
      transitions: [
        ...one.transitions,
        {
          ...one.transitions[0],
          transitionId: "tr2",
          payload: {
            ...one.transitions[0].payload,
            facetKey: "affiliation.unit",
            toValue: { kind: "text" as const, text: "第三小隊" },
          },
        },
      ],
    };
    expect(evaluatePhasePersistenceGate(two)).toEqual({
      kind: "proposal",
      reason: "multi-moderate-durable",
    });
  });

  it("rejects retrospective-only candidates for Phase proposals", () => {
    const candidate = {
      candidateId: "c1",
      entityId: "ent:raika",
      anchorDocumentRef: "S0001",
      transitionIds: ["tr1"],
      transitions: [
        {
          transitionId: "tr1",
          observationRefs: ["o1"],
          payload: {
            entityId: "ent:raika",
            facetKey: "role.current",
            trackId: "t1",
            fromValue: null,
            toValue: { kind: "text" as const, text: "隊長" },
            magnitude: "major" as const,
            durability: "major" as const,
            anchorDocumentRef: "S0001",
            retrospectiveOnly: true,
          },
          epistemic: {
            polarity: "affirmed" as const,
            commitment: "story-fact" as const,
            support: "direct" as const,
            narrativeFrame: "memory" as const,
          },
        },
      ],
    };
    expect(evaluatePhasePersistenceGate(candidate)).toEqual({
      kind: "rejected",
      reason: "retrospective-only",
    });
    const boundaries = synthesizePhaseBoundaries([candidate], {
      createId: () => "b1",
    });
    const plan = planPhaseAndDetailProposals({
      boundaries,
      detailProjections: [],
      existingPhases: [],
      extractionScope: "full-corpus",
      createId: () => "p1",
    });
    expect(plan.phaseProposals).toHaveLength(0);
  });

  it("Base Detail: timeless allowed; partial scope rejects corpus-initial", () => {
    const projectionTimeless: DetailProjectionHypothesis = {
      projectionId: "proj1",
      observationRefs: ["o1"],
      payload: {
        entityId: "ent:raika",
        facetKey: "role.current",
        destination: "base",
        scope: { kind: "base", temporalEligibility: "timeless" },
        binding: {
          status: "resolved",
          definitionRef: "D0001",
          basis: "confirmed-binding",
        },
        write: {
          kind: "set",
          value: { kind: "enum", optionRef: "OPT_hero" },
        },
        value: { kind: "enum", optionRef: "OPT_hero" },
      },
    };
    const projectionCorpusInitial: DetailProjectionHypothesis = {
      ...projectionTimeless,
      projectionId: "proj2",
      payload: {
        ...projectionTimeless.payload,
        scope: { kind: "base", temporalEligibility: "corpus-initial" },
      },
    };

    const full = planPhaseAndDetailProposals({
      boundaries: [],
      detailProjections: [projectionTimeless, projectionCorpusInitial],
      existingPhases: [],
      extractionScope: "full-corpus",
      createId: () => `p${++seq}`,
    });
    expect(full.baseDetailProposals).toHaveLength(2);

    const partial = planPhaseAndDetailProposals({
      boundaries: [],
      detailProjections: [projectionTimeless, projectionCorpusInitial],
      existingPhases: [],
      extractionScope: "partial",
      createId: () => `p${++seq}`,
    });
    expect(partial.baseDetailProposals).toHaveLength(1);
    expect(partial.baseDetailProposals[0].proposal.payload.temporalEligibility).toBe(
      "timeless",
    );
  });

  it("dropdown compose accepts opaque option refs only", () => {
    const definition: DetailDefinitionCatalogRecord = {
      definitionRef: "D0001",
      name: "役割",
      fieldType: "dropdown",
      options: [
        { optionRef: "OPT_hero", label: "主人公" },
        { optionRef: "OPT_side", label: "脇役" },
      ],
    };
    const ok = composeDetailValue({
      definition,
      assertionValue: { kind: "enum", optionRef: "OPT_hero" },
      optionRefs: new Set(["OPT_hero", "OPT_side"]),
    });
    expect(ok).toEqual({ kind: "enum", optionRef: "OPT_hero" });

    expect(() =>
      composeDetailValue({
        definition,
        assertionValue: { kind: "text", text: "主人公" },
        optionRefs: new Set(["OPT_hero"]),
      }),
    ).toThrow(DetailComposeError);

    expect(() =>
      composeDetailValue({
        definition,
        assertionValue: { kind: "enum", optionRef: "OPT_unknown" },
        optionRefs: new Set(["OPT_hero"]),
      }),
    ).toThrow(/Unknown dropdown option ref/);
  });

  it("keeps clear ≠ inherit ≠ set distinct", () => {
    expect(toPhaseDetailWrite("clear", null)).toEqual({ kind: "clear" });
    expect(toPhaseDetailWrite("inherit", null)).toEqual({ kind: "inherit" });
    expect(
      toPhaseDetailWrite("set", { kind: "text", text: "監察官" }),
    ).toEqual({
      kind: "set",
      value: { kind: "text", text: "監察官" },
    });
    // clear value under set becomes clear write, never inherit
    expect(toPhaseDetailWrite("set", { kind: "clear" })).toEqual({
      kind: "clear",
    });
  });

  it("Phase proposal defaults summary leave and forbids content/context overrides", () => {
    const proposal = createNewBindCodexPhaseProposal(
      {
        narrativeEntityId: "ent:raika",
        anchorDocumentRef: "S0001",
        labelSuggestion: "負傷後",
        detailOverrides: [
          {
            definitionRef: "D0001",
            write: { kind: "set", value: { kind: "text", text: "右腕負傷" } },
          },
          { definitionRef: "D0002", write: { kind: "clear" } },
          { definitionRef: "D0003", write: { kind: "inherit" } },
        ],
        binding: {
          kind: "create-new",
          phase: { label: "負傷後", anchorDocumentRef: "S0001" },
        },
      },
      { createId: () => "phase-p1" },
    );
    expect(proposal.payload.summaryOverride).toEqual({ kind: "leave" });
    expect(proposal.payload).not.toHaveProperty("contentOverride");
    expect(proposal.payload).not.toHaveProperty("contextModeOverride");
    expect(proposal.payload.detailOverrides.map((item) => item.write.kind)).toEqual([
      "set",
      "clear",
      "inherit",
    ]);
  });

  it("rejects clear values for Base Detail set proposals", () => {
    expect(
      createSetCodexBaseDetailProposal({
        narrativeEntityId: "ent:raika",
        definitionRef: "D0001",
        facetKey: "role.current",
        value: { kind: "clear" },
        temporalEligibility: "timeless",
        createId: () => "base-1",
      }),
    ).toBeNull();
  });
});
