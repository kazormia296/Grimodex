import { beforeEach, describe, expect, it } from "vitest";
import { createNewBindCodexPhaseProposal } from "@/features/narrative-extraction/proposals/bindCodexPhaseProposal";
import { createSetCodexBaseDetailProposal } from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";
import {
  buildCodexBaseDetailProposalSafetyFlags,
  buildCodexPhaseProposalSafetyFlags,
  isSafeForCodexBaseDetailBulkApprove,
  isSafeForCodexPhaseBulkApprove,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
  type CodexBaseDetailReviewProposal,
  type CodexPhaseReviewProposal,
  type CodexStructureExtractionReviewProjection,
} from "./codexStructureExtractionStore";

function emptyProjection(
  overrides: Partial<CodexStructureExtractionReviewProjection> = {},
): CodexStructureExtractionReviewProjection {
  return {
    runId: "run-1",
    projectId: "project-a",
    workspacePath: "/workspace-a",
    openRevision: 1,
    proposalSetId: "ps-1",
    status: "completed",
    coverage: { mode: "complete", windowCount: 1, completedWindows: 1 },
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
    },
    proposals: [],
    relationProposals: [],
    baseDetailProposals: [],
    phaseProposals: [],
    entityCount: 0,
    relationCount: 0,
    baseDetailCount: 0,
    phaseCount: 0,
    unresolvedCount: 0,
    approvedCount: 0,
    catalog: null,
    ...overrides,
  };
}

function safeBase(
  overrides: Partial<CodexBaseDetailReviewProposal> = {},
): CodexBaseDetailReviewProposal {
  const proposal = createSetCodexBaseDetailProposal({
    narrativeEntityId: "ne-1",
    definitionRef: "D0001",
    facetKey: "role.current",
    value: { kind: "text", text: "騎士" },
    temporalEligibility: "timeless",
    createId: () => "base-safe",
  });
  if (!proposal) throw new Error("expected base proposal");
  return {
    proposalId: "base-safe",
    revisionId: "rev-base",
    proposalKey: "base-key",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: "ライカ · role.current",
    proposal,
    evidence: [
      {
        anchorId: "b1",
        quote: "騎士として知られる",
        documentRef: "B000001",
        method: "exact",
      },
    ],
    safety: buildCodexBaseDetailProposalSafetyFlags({
      temporalEligibility: "timeless",
      existingValue: null,
      evidenceMethods: ["exact"],
      bound: true,
      valueKind: "text",
    }),
    entityLabel: "ライカ",
    facetKey: "role.current",
    existingValue: null,
    ...overrides,
  };
}

function safePhase(
  overrides: Partial<CodexPhaseReviewProposal> = {},
): CodexPhaseReviewProposal {
  const proposal = createNewBindCodexPhaseProposal(
    {
      narrativeEntityId: "ne-1",
      anchorDocumentRef: "S0001",
      labelSuggestion: "負傷後",
      detailOverrides: [
        {
          definitionRef: "D0001",
          write: { kind: "set", value: { kind: "text", text: "右腕負傷" } },
        },
      ],
      binding: {
        kind: "create-new",
        phase: { label: "負傷後", anchorDocumentRef: "S0001" },
      },
    },
    { proposalId: "phase-safe" },
  );
  return {
    proposalId: "phase-safe",
    revisionId: "rev-phase",
    proposalKey: "phase-key",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: "負傷後",
    proposal,
    evidence: [
      {
        anchorId: "p1",
        quote: "右腕を負傷した",
        documentRef: "S0001",
        method: "exact",
      },
    ],
    safety: buildCodexPhaseProposalSafetyFlags({
      summaryOverrideKind: "leave",
      bindingKind: "create-new",
      hasConflict: false,
      bound: true,
      hasClearWrite: false,
    }),
    entityLabel: "ライカ",
    persistence: { kind: "proposal", reason: "major-durable" },
    valueDeltas: [
      {
        definitionRef: "D0001",
        facetKey: "injury.severe.arm",
        previousDisplay: "(empty)",
        nextDisplay: "右腕負傷",
        writeKind: "set",
      },
    ],
    existingPhaseCandidates: [],
    ...overrides,
  };
}

describe("isSafeForCodexBaseDetailBulkApprove", () => {
  it("requires timeless + empty existing + lossless + bound + not clear/summarized", () => {
    const safe = buildCodexBaseDetailProposalSafetyFlags({
      temporalEligibility: "timeless",
      existingValue: null,
      evidenceMethods: ["exact"],
      bound: true,
      valueKind: "text",
    });
    expect(isSafeForCodexBaseDetailBulkApprove(safe)).toBe(true);
    expect(
      isSafeForCodexBaseDetailBulkApprove({
        ...safe,
        timeless: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexBaseDetailBulkApprove({
        ...safe,
        emptyExisting: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexBaseDetailBulkApprove({
        ...safe,
        lossless: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexBaseDetailBulkApprove({
        ...safe,
        bound: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexBaseDetailBulkApprove({
        ...safe,
        notClear: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexBaseDetailBulkApprove({
        ...safe,
        notSummarized: false,
      }),
    ).toBe(false);
  });
});

describe("isSafeForCodexPhaseBulkApprove", () => {
  it("requires no summary override, no conflict, bound, and excludes clear/append", () => {
    const safe = buildCodexPhaseProposalSafetyFlags({
      summaryOverrideKind: "leave",
      bindingKind: "create-new",
      hasConflict: false,
      bound: true,
      hasClearWrite: false,
    });
    expect(isSafeForCodexPhaseBulkApprove(safe)).toBe(true);
    expect(
      isSafeForCodexPhaseBulkApprove({
        ...safe,
        noSummaryOverride: false,
        notSummarized: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexPhaseBulkApprove({
        ...safe,
        noConflict: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexPhaseBulkApprove({
        ...safe,
        notExistingPhaseAppend: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexPhaseBulkApprove({
        ...safe,
        notClear: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexPhaseBulkApprove({
        ...safe,
        bound: false,
      }),
    ).toBe(false);
  });
});

describe("codexStructureExtractionStore phase/base bulkApproveSafe", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
  });

  it("bulk-approves only safe base and safe phases; excludes clear/summarized/unbound/append", () => {
    const baseOk = safeBase();
    const baseExisting = safeBase({
      proposalId: "base-existing",
      safety: buildCodexBaseDetailProposalSafetyFlags({
        temporalEligibility: "timeless",
        existingValue: { kind: "text", text: "旧値" },
        evidenceMethods: ["exact"],
        bound: true,
        valueKind: "text",
      }),
      existingValue: { kind: "text", text: "旧値" },
    });
    const baseUnbound = safeBase({
      proposalId: "base-unbound",
      unbound: true,
      applicability: "blocked",
      safety: buildCodexBaseDetailProposalSafetyFlags({
        temporalEligibility: "timeless",
        existingValue: null,
        evidenceMethods: ["exact"],
        bound: false,
        valueKind: "text",
      }),
    });
    const phaseOk = safePhase();
    const phaseAppend = safePhase({
      proposalId: "phase-append",
      proposal: {
        ...safePhase().proposal,
        proposalId: "phase-append",
        target: { kind: "existing", phaseRef: "PH1" },
        payload: {
          ...safePhase().proposal.payload,
          binding: {
            kind: "bind-existing",
            phaseRef: "PH1",
            expectedVersion: 1,
          },
        },
      },
      safety: buildCodexPhaseProposalSafetyFlags({
        summaryOverrideKind: "leave",
        bindingKind: "bind-existing",
        hasConflict: false,
        bound: true,
        hasClearWrite: false,
      }),
    });
    const phaseSummarized = safePhase({
      proposalId: "phase-summarized",
      proposal: {
        ...safePhase().proposal,
        proposalId: "phase-summarized",
        payload: {
          ...safePhase().proposal.payload,
          summaryOverride: { kind: "set", value: "要約" },
        },
      },
      safety: buildCodexPhaseProposalSafetyFlags({
        summaryOverrideKind: "set",
        bindingKind: "create-new",
        hasConflict: false,
        bound: true,
        hasClearWrite: false,
      }),
    });
    const phaseClear = safePhase({
      proposalId: "phase-clear",
      safety: buildCodexPhaseProposalSafetyFlags({
        summaryOverrideKind: "leave",
        bindingKind: "create-new",
        hasConflict: false,
        bound: true,
        hasClearWrite: true,
      }),
    });

    useCodexStructureExtractionStore.getState().setProjection(
      emptyProjection({
        baseDetailProposals: [baseOk, baseExisting, baseUnbound],
        phaseProposals: [phaseOk, phaseAppend, phaseSummarized, phaseClear],
      }),
    );

    const count = useCodexStructureExtractionStore.getState().bulkApproveSafe();
    expect(count).toBe(2);

    const projection = useCodexStructureExtractionStore.getState().projection;
    expect(
      projection?.baseDetailProposals.map((item) => [
        item.proposalId,
        item.status,
      ]),
    ).toEqual([
      ["base-safe", "approved"],
      ["base-existing", "unreviewed"],
      ["base-unbound", "unreviewed"],
    ]);
    expect(
      projection?.phaseProposals.map((item) => [item.proposalId, item.status]),
    ).toEqual([
      ["phase-safe", "approved"],
      ["phase-append", "unreviewed"],
      ["phase-summarized", "unreviewed"],
      ["phase-clear", "unreviewed"],
    ]);
  });
});
