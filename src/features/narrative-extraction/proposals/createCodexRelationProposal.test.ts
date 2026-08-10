import { describe, expect, it } from "vitest";
import {
  CODEX_RELATION_CREATE_PROPOSAL_KIND,
  createCodexRelationProposalFromHypothesis,
} from "./createCodexRelationProposal";
import { evaluateRelationDomainGate } from "@/features/codex/extraction/relationSynthesis";
import type { CodexRelationHypothesis } from "../ir/inferences/codexRelationHypothesis";

const baseHypothesis: CodexRelationHypothesis = {
  hypothesisId: "h1",
  observationRefs: ["obs-1"],
  subjectResolved: true,
  objectResolved: true,
  payload: {
    subjectEntityId: "e1",
    objectEntityId: "e2",
    predicate: "弟子",
    family: "social",
    validity: "current",
    directionality: "directed",
    forwardLabelSuggestion: "弟子",
    inverseLabelSuggestion: "師匠",
  },
  epistemic: {
    polarity: "affirmed",
    commitment: "story-fact",
    support: "direct",
    narrativeFrame: "primary",
  },
};

describe("createCodexRelationProposalFromHypothesis", () => {
  it("builds a create proposal for gated timeless/current facts", () => {
    const gate = evaluateRelationDomainGate(baseHypothesis);
    expect(gate.kind).toBe("proposal");
    const proposal = createCodexRelationProposalFromHypothesis({
      hypothesis: baseHypothesis,
      gate,
      logicalRef: "rel-1",
      relation: {
        relationType: "disciple",
        directionality: "directed",
        forwardLabel: "弟子",
        inverseLabel: "師匠",
      },
      dependencyProposalIds: ["bind-e1", "bind-e2"],
      createId: () => "p-rel-1",
    });
    expect(proposal).not.toBeNull();
    expect(proposal?.kind).toBe(CODEX_RELATION_CREATE_PROPOSAL_KIND);
    expect(proposal?.target).toEqual({ kind: "new", logicalRef: "rel-1" });
    expect(proposal?.payload.validity).toBe("current");
    expect(proposal?.dependencies).toEqual([
      { kind: "requires-resolution", proposalId: "bind-e1" },
      { kind: "requires-resolution", proposalId: "bind-e2" },
    ]);
  });

  it("returns null for report-only / blocked gates", () => {
    const historical = {
      ...baseHypothesis,
      payload: { ...baseHypothesis.payload, validity: "historical" as const },
    };
    expect(
      createCodexRelationProposalFromHypothesis({
        hypothesis: historical,
        gate: evaluateRelationDomainGate(historical),
        logicalRef: "rel-2",
        relation: {
          relationType: "custom",
          directionality: "directed",
          forwardLabel: "弟子",
          inverseLabel: "師匠",
        },
        dependencyProposalIds: ["bind-e1", "bind-e2"],
      }),
    ).toBeNull();
  });
});
