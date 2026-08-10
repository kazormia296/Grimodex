import { beforeEach, describe, expect, it } from "vitest";
import {
  unresolvedBindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import { createCodexRelationProposalFromHypothesis } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import { buildCodexRelationSemanticKey } from "./extraction/relationVocabulary";
import {
  buildCodexEntityProposalSafetyFlags,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
  type CodexEntityReviewProposal,
  type CodexRelationReviewProposal,
  type CodexStructureExtractionReviewProjection,
} from "./codexStructureExtractionStore";

function entityRow(
  overrides: Partial<CodexEntityReviewProposal> & {
    proposalId: string;
    narrativeEntityId: string;
    name: string;
  },
): CodexEntityReviewProposal {
  const proposal =
    overrides.proposal ??
    unresolvedBindCodexEntityProposal(
      {
        narrativeEntityId: overrides.narrativeEntityId,
        canonicalName: overrides.name,
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "unresolved",
          candidates: [
            {
              ref: "K0001",
              score: 0.9,
              methods: ["exact-name"],
            },
          ],
          allowCreateNew: true,
        },
      },
      { proposalId: overrides.proposalId },
    );
  const { proposalId, narrativeEntityId, name, proposal: _p, ...rest } = overrides;
  return {
    proposalId,
    revisionId: overrides.revisionId ?? `rev-${proposalId}`,
    proposalKey: narrativeEntityId,
    status: "unreviewed",
    applicability: "blocked",
    displayTitle: name,
    proposal,
    evidence: [
      {
        anchorId: "a1",
        quote: name,
        documentRef: "D1",
        method: "exact",
      },
    ],
    safety: buildCodexEntityProposalSafetyFlags({
      bindingKind: "unresolved",
      typeStatus: "resolved",
      evidenceMethods: ["exact"],
      hasExistingCandidates: true,
      hasProperNameMention: true,
      aliasesAllExplicit: true,
    }),
    ...rest,
  };
}

describe("Codex Relation rematch after Binding resolve", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
  });

  it("marks Relation already-satisfied after both endpoints resolve to existing Entries", () => {
    const left = entityRow({
      proposalId: "ent-1",
      narrativeEntityId: "ne-1",
      name: "ライカ",
    });
    const right = entityRow({
      proposalId: "ent-2",
      narrativeEntityId: "ne-2",
      name: "ベルカ",
      proposal: unresolvedBindCodexEntityProposal(
        {
          narrativeEntityId: "ne-2",
          canonicalName: "ベルカ",
          aliases: [],
          coarseClass: "person",
          typeResolution: { status: "resolved", typeRef: "T0001" },
          binding: {
            kind: "unresolved",
            candidates: [
              {
                ref: "K0002",
                score: 0.9,
                methods: ["exact-name"],
              },
            ],
            allowCreateNew: true,
          },
        },
        { proposalId: "ent-2" },
      ),
    });

    const relationProposal = createCodexRelationProposalFromHypothesis({
      hypothesis: {
        hypothesisId: "hyp-rel",
        observationRefs: [],
        subjectResolved: true,
        objectResolved: true,
        payload: {
          subjectEntityId: "ne-1",
          objectEntityId: "ne-2",
          predicate: "friend_of",
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
        relationType: "friend_of",
        directionality: "symmetric",
        forwardLabel: "友人",
        inverseLabel: "友人",
      },
      dependencyProposalIds: ["ent-1", "ent-2"],
      createId: () => "rel-1",
    })!;

    const semanticKey = buildCodexRelationSemanticKey({
      projectId: "project-a",
      fromCodexId: "entry-laika",
      toCodexId: "entry-belka",
      relationType: "friend_of",
      directionality: "symmetric",
      forwardLabel: "友人",
      inverseLabel: "友人",
    });

    const relation: CodexRelationReviewProposal = {
      proposalId: "rel-1",
      revisionId: "rev-rel",
      proposalKey: "rel-key",
      status: "unreviewed",
      applicability: "blocked",
      displayTitle: "友人",
      proposal: relationProposal,
      evidence: [],
      subjectLabel: "ライカ",
      objectLabel: "ベルカ",
      blockedReason: "先に両端の Entity proposal を承認してください",
    };

    const projection: CodexStructureExtractionReviewProjection = {
      runId: "run-1",
      projectId: "project-a",
      workspacePath: "/ws",
      openRevision: 1,
      proposalSetId: "ps-1",
      folderId: "folder-a",
      status: "completed",
      coverage: {},
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
      proposals: [left, right],
      relationProposals: [relation],
      entityCount: 2,
      relationCount: 1,
      unresolvedCount: 2,
      approvedCount: 0,
      catalog: {
        entities: [
          {
            ref: "K0001",
            sourceKey: "entry-laika",
            name: "ライカ",
            typeRef: "T0001",
          },
          {
            ref: "K0002",
            sourceKey: "entry-belka",
            name: "ベルカ",
            typeRef: "T0001",
          },
        ],
        types: [
          {
            ref: "T0001",
            sourceKey: "character",
            slug: "character",
            label: "character",
          },
        ],
      },
      existingRelations: [
        {
          ref: "R0001",
          sourceKey: "rel-existing",
          semanticKey,
          fromCodexId: "entry-laika",
          toCodexId: "entry-belka",
          relationType: "friend_of",
          directionality: "symmetric",
          forwardLabel: "友人",
          inverseLabel: "友人",
        },
      ],
    };

    useCodexStructureExtractionStore.getState().setProjection(projection);
    useCodexStructureExtractionStore
      .getState()
      .resolveBinding("ent-1", { kind: "bind-existing", entityRef: "K0001" });
    useCodexStructureExtractionStore
      .getState()
      .resolveBinding("ent-2", { kind: "bind-existing", entityRef: "K0002" });

    // Approve both entities so endpoint readiness would otherwise become applicable.
    useCodexStructureExtractionStore
      .getState()
      .updateProposalStatus("ent-1", "approved");
    useCodexStructureExtractionStore
      .getState()
      .updateProposalStatus("ent-2", "approved");

    const rematched =
      useCodexStructureExtractionStore.getState().projection
        ?.relationProposals[0];
    expect(rematched?.applicability).toBe("already-satisfied");
    expect(rematched?.existingRelationRef).toBe("R0001");
  });
});
