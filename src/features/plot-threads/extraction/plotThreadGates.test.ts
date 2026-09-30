import { describe, expect, it } from "vitest";
import {
  assignMarkerRoles,
  meetsNewThreadMinimum,
  shouldCreateMarkerCandidate,
} from "./markerRoleAssigner";
import { isMaterialDevelopment } from "@/features/narrative-extraction/ir/inferences/threadDevelopment";
import { evaluateThreadRelationGate } from "./threadRelationSynthesis";

describe("Plot Thread marker gates", () => {
  it("does not create a new thread from a single scene", () => {
    expect(
      meetsNewThreadMinimum({
        materialDevelopmentCount: 2,
        distinctSceneCount: 1,
        hasCoreConcern: true,
        exactEvidenceSites: 2,
      }),
    ).toBe(false);
  });

  it("allows new threads with two scenes and material developments", () => {
    expect(
      meetsNewThreadMinimum({
        materialDevelopmentCount: 2,
        distinctSceneCount: 2,
        hasCoreConcern: true,
        exactEvidenceSites: 2,
      }),
    ).toBe(true);
  });

  it("rejects background-only mentions as markers", () => {
    expect(
      shouldCreateMarkerCandidate({
        advancement: "progresses",
        materiality: "moderate",
        isBackgroundMentionOnly: true,
      }),
    ).toBe(false);
  });

  it("does not force introduce when scope is preexisting", () => {
    const roles = assignMarkerRoles([
      {
        documentRef: "doc:s2",
        readingOrderIndex: 0,
        advancement: "establishes",
        developmentInferenceId: "inf:1",
        evidenceAnchorIds: ["ev:1"],
        isFirstInScope: true,
        scopeEntry: "preexisting-before-scope",
        hasStableClosureEvidence: false,
      },
    ]);
    expect(roles[0]?.primaryPhase).toBe("develop");
  });

  it("maps establishes to introduce inside full scope", () => {
    const roles = assignMarkerRoles([
      {
        documentRef: "doc:s1",
        readingOrderIndex: 0,
        advancement: "establishes",
        developmentInferenceId: "inf:1",
        evidenceAnchorIds: ["ev:1"],
        isFirstInScope: true,
        scopeEntry: "introduced-in-scope",
        hasStableClosureEvidence: false,
      },
    ]);
    expect(roles[0]?.primaryPhase).toBe("introduce");
  });

  it("does not treat last marker as resolve without closure evidence", () => {
    const roles = assignMarkerRoles([
      {
        documentRef: "doc:s9",
        readingOrderIndex: 9,
        advancement: "resolves",
        developmentInferenceId: "inf:9",
        evidenceAnchorIds: ["ev:9"],
        isFirstInScope: false,
        scopeEntry: "introduced-in-scope",
        hasStableClosureEvidence: false,
      },
    ]);
    expect(roles[0]?.primaryPhase).toBe("develop");
  });

  it("allows resolve when stable closure evidence exists", () => {
    const roles = assignMarkerRoles([
      {
        documentRef: "doc:s9",
        readingOrderIndex: 9,
        advancement: "resolves",
        developmentInferenceId: "inf:9",
        evidenceAnchorIds: ["ev:9"],
        isFirstInScope: false,
        scopeEntry: "introduced-in-scope",
        hasStableClosureEvidence: true,
      },
    ]);
    expect(roles[0]?.primaryPhase).toBe("resolve");
  });

  it("maps redirects to turn", () => {
    const roles = assignMarkerRoles([
      {
        documentRef: "doc:s4",
        readingOrderIndex: 4,
        advancement: "redirects",
        developmentInferenceId: "inf:4",
        evidenceAnchorIds: ["ev:4"],
        isFirstInScope: false,
        scopeEntry: "introduced-in-scope",
        hasStableClosureEvidence: false,
      },
    ]);
    expect(roles[0]?.primaryPhase).toBe("turn");
  });

  it("does not treat confronts as resolve", () => {
    const roles = assignMarkerRoles([
      {
        documentRef: "doc:s8",
        readingOrderIndex: 8,
        advancement: "confronts",
        developmentInferenceId: "inf:8",
        evidenceAnchorIds: ["ev:8"],
        isFirstInScope: false,
        scopeEntry: "introduced-in-scope",
        hasStableClosureEvidence: false,
      },
    ]);
    expect(roles[0]?.primaryPhase).toBe("climax");
  });

  it("marks minor secondary developments as non-material", () => {
    expect(
      isMaterialDevelopment({
        developmentId: "d1",
        documentRef: "doc:1",
        sourceEventInferenceIds: [],
        sourceStateInferenceIds: [],
        sourceGoalInferenceIds: [],
        sourceConflictInferenceIds: [],
        sourceQuestionInferenceIds: [],
        advancement: "progresses",
        materiality: "minor",
        centrality: "secondary",
        explanation: "mention",
      }),
    ).toBe(false);
  });
});

describe("Plot Thread relation gates", () => {
  it("does not create a branch from a shared scene alone", () => {
    const result = evaluateThreadRelationGate({
      kind: "branch",
      bothIdentitiesResolved: true,
      anchorExactEvidence: true,
      targetHasIndependentCoreAfterAnchor: true,
      sourceContinuesIndependentlyAfterAnchor: true,
      coverageComplete: true,
      mereSharedScene: true,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects merge under partial coverage", () => {
    const result = evaluateThreadRelationGate({
      kind: "merge",
      bothIdentitiesResolved: true,
      anchorExactEvidence: true,
      targetHasIndependentCoreAfterAnchor: false,
      sourceContinuesIndependentlyAfterAnchor: false,
      coverageComplete: false,
      mereSharedScene: false,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects merge when source stays independent", () => {
    const result = evaluateThreadRelationGate({
      kind: "merge",
      bothIdentitiesResolved: true,
      anchorExactEvidence: true,
      targetHasIndependentCoreAfterAnchor: false,
      sourceContinuesIndependentlyAfterAnchor: true,
      coverageComplete: true,
      mereSharedScene: false,
    });
    expect(result.ok).toBe(false);
  });
});
