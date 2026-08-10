import { beforeEach, describe, expect, it } from "vitest";
import {
  createNewBindCodexEntityProposal,
  bindExistingCodexEntityProposal,
  unresolvedBindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import {
  buildCodexEntityProposalSafetyFlags,
  isSafeForCodexEntityBulkApprove,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
  type CodexEntityReviewProposal,
  type CodexStructureExtractionReviewProjection,
} from "./codexStructureExtractionStore";
import { createCodexRelationProposalFromHypothesis } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";

const basePayloadFields = {
  narrativeEntityId: "ne-1",
  canonicalName: "ライカ",
  aliases: [] as { surface: string; status: "explicit" }[],
  coarseClass: "person" as const,
  typeResolution: { status: "resolved" as const, typeRef: "T0001" },
};

function safeCreateProposal(
  overrides: Partial<CodexEntityReviewProposal> = {},
): CodexEntityReviewProposal {
  const proposal = createNewBindCodexEntityProposal(
    {
      ...basePayloadFields,
      binding: {
        kind: "create-new",
        entry: { name: "ライカ", aliases: [], summary: "騎士" },
      },
    },
    { proposalId: "safe-1" },
  );
  return {
    proposalId: "safe-1",
    revisionId: "rev-1",
    proposalKey: "key-1",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: "ライカ",
    proposal,
    evidence: [
      {
        anchorId: "a1",
        quote: "ライカは槍を構えた",
        documentRef: "D000001",
        method: "exact",
      },
    ],
    safety: buildCodexEntityProposalSafetyFlags({
      bindingKind: "create-new",
      typeStatus: "resolved",
      evidenceMethods: ["exact"],
      hasExistingCandidates: false,
      hasProperNameMention: true,
      aliasesAllExplicit: true,
    }),
    ...overrides,
  };
}

function projection(
  proposals: CodexEntityReviewProposal[],
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
    proposals,
    relationProposals: [],
    entityCount: proposals.length,
    relationCount: 0,
    unresolvedCount: proposals.filter((p) => p.status === "unreviewed").length,
    approvedCount: proposals.filter((p) => p.status === "approved").length,
    catalog: null,
  };
}

describe("isSafeForCodexEntityBulkApprove", () => {
  it("requires evidence exact, type resolved, no candidates, proper-name, explicit aliases, no relation deps, create-new", () => {
    const safe = buildCodexEntityProposalSafetyFlags({
      bindingKind: "create-new",
      typeStatus: "resolved",
      evidenceMethods: ["exact"],
      hasExistingCandidates: false,
      hasProperNameMention: true,
      aliasesAllExplicit: true,
    });
    expect(isSafeForCodexEntityBulkApprove(safe)).toBe(true);

    expect(isSafeForCodexEntityBulkApprove({ ...safe, createNew: false })).toBe(
      false,
    );
    expect(
      isSafeForCodexEntityBulkApprove({
        ...safe,
        noExistingCandidates: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexEntityBulkApprove({
        ...safe,
        explicitProperName: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexEntityBulkApprove({ ...safe, evidenceExact: false }),
    ).toBe(false);
    expect(
      isSafeForCodexEntityBulkApprove({ ...safe, typeResolved: false }),
    ).toBe(false);
    expect(
      isSafeForCodexEntityBulkApprove({
        ...safe,
        explicitAliasesOnly: false,
      }),
    ).toBe(false);
    expect(
      isSafeForCodexEntityBulkApprove({ ...safe, noRelationDeps: false }),
    ).toBe(false);
  });
});

describe("codexStructureExtractionStore", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
  });

  it("bulkApproveSafe only approves safe create-new proposals", () => {
    const safe = safeCreateProposal({ proposalId: "safe" });
    const existing = safeCreateProposal({
      proposalId: "existing",
      proposal: bindExistingCodexEntityProposal(
        {
          ...basePayloadFields,
          binding: {
            kind: "bind-existing",
            entityRef: "K0001",
            enrichment: {
              aliasesToAdd: ["灰の目"],
              summary: { kind: "leave" },
            },
          },
        },
        { proposalId: "existing" },
      ),
      safety: buildCodexEntityProposalSafetyFlags({
        bindingKind: "bind-existing",
        typeStatus: "resolved",
        evidenceMethods: ["exact"],
        hasExistingCandidates: true,
        hasProperNameMention: true,
        aliasesAllExplicit: true,
      }),
    });
    const unresolved = safeCreateProposal({
      proposalId: "unresolved",
      applicability: "blocked",
      proposal: unresolvedBindCodexEntityProposal(
        {
          ...basePayloadFields,
          binding: {
            kind: "unresolved",
            candidates: [{ ref: "K0001", score: 90, methods: ["exact-name"] }],
            allowCreateNew: true,
          },
        },
        { proposalId: "unresolved" },
      ),
      safety: buildCodexEntityProposalSafetyFlags({
        bindingKind: "unresolved",
        typeStatus: "resolved",
        evidenceMethods: ["exact"],
        hasExistingCandidates: true,
        hasProperNameMention: true,
        aliasesAllExplicit: true,
      }),
    });

    useCodexStructureExtractionStore
      .getState()
      .setProjection(projection([safe, existing, unresolved]));
    const count = useCodexStructureExtractionStore.getState().bulkApproveSafe();
    expect(count).toBe(1);
    const statuses = useCodexStructureExtractionStore
      .getState()
      .projection?.proposals.map((item) => [item.proposalId, item.status]);
    expect(statuses).toEqual([
      ["safe", "approved"],
      ["existing", "unreviewed"],
      ["unresolved", "unreviewed"],
    ]);
  });

  it("reviseProposalFields resets approval to unreviewed without inventing revision ids", () => {
    useCodexStructureExtractionStore
      .getState()
      .setProjection(projection([safeCreateProposal({ status: "approved" })]));
    useCodexStructureExtractionStore
      .getState()
      .reviseProposalFields("safe-1", { canonicalName: "雷牙" });
    const updated =
      useCodexStructureExtractionStore.getState().projection?.proposals[0];
    expect(updated?.status).toBe("unreviewed");
    expect(updated?.displayTitle).toBe("雷牙");
    // Native appendRevision must supply the next revisionId (store keeps OCC base).
    expect(updated?.revisionId).toBe("rev-1");
  });

  it("blocks Relation approval until both endpoint Entities are approved", () => {
    const subject = safeCreateProposal({
      proposalId: "ent-1",
      status: "unreviewed",
    });
    const object = safeCreateProposal({
      proposalId: "ent-2",
      proposal: createNewBindCodexEntityProposal(
        {
          ...basePayloadFields,
          narrativeEntityId: "ne-2",
          canonicalName: "ベルカ",
          binding: {
            kind: "create-new",
            entry: { name: "ベルカ", aliases: [], summary: null },
          },
        },
        { proposalId: "ent-2" },
      ),
      displayTitle: "ベルカ",
    });
    const relation = createCodexRelationProposalFromHypothesis({
      hypothesis: {
        hypothesisId: "h-rel",
        observationRefs: ["obs"],
        subjectResolved: true,
        objectResolved: true,
        payload: {
          subjectEntityId: "ne-1",
          objectEntityId: "ne-2",
          predicate: "friend",
          family: "social",
          validity: "current",
          directionality: "symmetric",
          forwardLabelSuggestion: "友人",
          inverseLabelSuggestion: "友人",
        },
        epistemic: {
          polarity: "affirmed",
          commitment: "story-fact",
          support: "direct",
          narrativeFrame: "primary",
        },
      },
      gate: { kind: "proposal", validity: "current" },
      logicalRef: "rel-1",
      relation: {
        relationType: "friend",
        directionality: "symmetric",
        forwardLabel: "友人",
        inverseLabel: "友人",
      },
      dependencyProposalIds: ["ent-1", "ent-2"],
      createId: () => "rel-1",
    });
    if (!relation) throw new Error("expected relation");

    useCodexStructureExtractionStore.getState().setProjection({
      ...projection([subject, object]),
      relationProposals: [
        {
          proposalId: "rel-1",
          revisionId: "rev-rel",
          proposalKey: "key-rel",
          status: "unreviewed",
          applicability: "blocked",
          blockedReason: "先に両端の Entity proposal を承認してください",
          displayTitle: "ライカ → 友人 → ベルカ",
          proposal: relation,
          evidence: [],
          subjectLabel: "ライカ",
          objectLabel: "ベルカ",
        },
      ],
      relationCount: 1,
      unresolvedCount: 1,
    });

    useCodexStructureExtractionStore
      .getState()
      .updateRelationProposalStatus("rel-1", "approved");
    expect(
      useCodexStructureExtractionStore.getState().projection
        ?.relationProposals[0]?.status,
    ).toBe("unreviewed");

    useCodexStructureExtractionStore
      .getState()
      .updateProposalStatus("ent-1", "approved");
    useCodexStructureExtractionStore
      .getState()
      .updateProposalStatus("ent-2", "approved");

    const afterEntities =
      useCodexStructureExtractionStore.getState().projection
        ?.relationProposals[0];
    expect(afterEntities?.applicability).toBe("applicable");
    expect(afterEntities?.blockedReason).toBeUndefined();

    useCodexStructureExtractionStore
      .getState()
      .updateRelationProposalStatus("rel-1", "approved");
    expect(
      useCodexStructureExtractionStore.getState().projection
        ?.relationProposals[0]?.status,
    ).toBe("approved");
  });

  it("re-blocks dependent Relations when an endpoint is rejected", () => {
    const subject = safeCreateProposal({
      proposalId: "ent-1",
      status: "approved",
    });
    const object = safeCreateProposal({
      proposalId: "ent-2",
      status: "approved",
      proposal: createNewBindCodexEntityProposal(
        {
          ...basePayloadFields,
          narrativeEntityId: "ne-2",
          canonicalName: "ベルカ",
          binding: {
            kind: "create-new",
            entry: { name: "ベルカ", aliases: [], summary: null },
          },
        },
        { proposalId: "ent-2" },
      ),
      displayTitle: "ベルカ",
    });
    const relation = createCodexRelationProposalFromHypothesis({
      hypothesis: {
        hypothesisId: "h-rel",
        observationRefs: ["obs"],
        subjectResolved: true,
        objectResolved: true,
        payload: {
          subjectEntityId: "ne-1",
          objectEntityId: "ne-2",
          predicate: "friend",
          family: "social",
          validity: "current",
          directionality: "symmetric",
          forwardLabelSuggestion: "友人",
          inverseLabelSuggestion: "友人",
        },
        epistemic: {
          polarity: "affirmed",
          commitment: "story-fact",
          support: "direct",
          narrativeFrame: "primary",
        },
      },
      gate: { kind: "proposal", validity: "current" },
      logicalRef: "rel-1",
      relation: {
        relationType: "friend",
        directionality: "symmetric",
        forwardLabel: "友人",
        inverseLabel: "友人",
      },
      dependencyProposalIds: ["ent-1", "ent-2"],
      createId: () => "rel-1",
    });
    if (!relation) throw new Error("expected relation");

    useCodexStructureExtractionStore.getState().setProjection({
      ...projection([subject, object]),
      relationProposals: [
        {
          proposalId: "rel-1",
          revisionId: "rev-rel",
          proposalKey: "key-rel",
          status: "approved",
          applicability: "applicable",
          displayTitle: "ライカ → 友人 → ベルカ",
          proposal: relation,
          evidence: [],
          subjectLabel: "ライカ",
          objectLabel: "ベルカ",
        },
      ],
      relationCount: 1,
      approvedCount: 3,
    });

    useCodexStructureExtractionStore
      .getState()
      .updateProposalStatus("ent-1", "rejected");
    const rel =
      useCodexStructureExtractionStore.getState().projection
        ?.relationProposals[0];
    expect(rel?.applicability).toBe("blocked");
    expect(rel?.blockedReason).toContain("Entity");
    expect(rel?.status).toBe("unreviewed");
  });

  it("swaps Relation subject and object endpoints", () => {
    const relation = createCodexRelationProposalFromHypothesis({
      hypothesis: {
        hypothesisId: "h-rel",
        observationRefs: ["obs"],
        subjectResolved: true,
        objectResolved: true,
        payload: {
          subjectEntityId: "ne-1",
          objectEntityId: "ne-2",
          predicate: "父",
          family: "social",
          validity: "current",
          directionality: "directed",
          forwardLabelSuggestion: "父",
          inverseLabelSuggestion: "子",
        },
        epistemic: {
          polarity: "affirmed",
          commitment: "story-fact",
          support: "direct",
          narrativeFrame: "primary",
        },
      },
      gate: { kind: "proposal", validity: "current" },
      logicalRef: "rel-1",
      relation: {
        relationType: "父",
        directionality: "directed",
        forwardLabel: "父",
        inverseLabel: "子",
      },
      dependencyProposalIds: [],
      createId: () => "rel-1",
    });
    if (!relation) throw new Error("expected relation");

    useCodexStructureExtractionStore.getState().setProjection({
      ...projection([]),
      relationProposals: [
        {
          proposalId: "rel-1",
          revisionId: "rev-rel",
          proposalKey: "key-rel",
          status: "unreviewed",
          applicability: "applicable",
          displayTitle: "ライカ → 父 → ベルカ",
          proposal: relation,
          evidence: [],
          subjectLabel: "ライカ",
          objectLabel: "ベルカ",
        },
      ],
      relationCount: 1,
    });

    useCodexStructureExtractionStore.getState().swapRelationEndpoints("rel-1");
    const swapped =
      useCodexStructureExtractionStore.getState().projection
        ?.relationProposals[0];
    expect(swapped?.proposal.payload.subjectEntityId).toBe("ne-2");
    expect(swapped?.proposal.payload.objectEntityId).toBe("ne-1");
    expect(swapped?.subjectLabel).toBe("ベルカ");
    expect(swapped?.objectLabel).toBe("ライカ");
    expect(swapped?.displayTitle).toContain("ベルカ");
    expect(swapped?.status).toBe("unreviewed");
  });
});
