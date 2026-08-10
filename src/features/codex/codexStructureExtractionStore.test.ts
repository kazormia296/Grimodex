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

    expect(
      isSafeForCodexEntityBulkApprove({ ...safe, createNew: false }),
    ).toBe(false);
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
            candidates: [
              { ref: "K0001", score: 90, methods: ["exact-name"] },
            ],
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

  it("reviseProposalFields resets approval to unreviewed", () => {
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
    expect(updated?.revisionId).not.toBe("rev-1");
  });
});
