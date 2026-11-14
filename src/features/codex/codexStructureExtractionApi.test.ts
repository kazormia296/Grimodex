import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

beforeEach(() => {
  setCurrentWorkspaceIdentity({ path: "/w", openRevision: 1 });
});

afterEach(() => {
  setCurrentWorkspaceIdentity(null);
});

const createRunMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const cancelRunMock = vi.hoisted(() => vi.fn());
const saveProposalSetMock = vi.hoisted(() => vi.fn());
const buildNativeReconciliationEnvelopeMock = vi.hoisted(() => vi.fn());
const buildSnapshotSourceBasisMock = vi.hoisted(() => vi.fn());
const appendDecisionMock = vi.hoisted(() => vi.fn());
const appendHumanDecisionMock = vi.hoisted(() => vi.fn());
const appendRevisionMock = vi.hoisted(() => vi.fn());
const reviseAndDecideAsHumanMock = vi.hoisted(() => vi.fn());
const prepareApplyMock = vi.hoisted(() => vi.fn());
const claimTaskMock = vi.hoisted(() => vi.fn());
const finishTaskMock = vi.hoisted(() => vi.fn());
const failTaskMock = vi.hoisted(() => vi.fn());
const captureWorkspaceBindingMock = vi.hoisted(() => vi.fn());
const buildSnapshotMock = vi.hoisted(() => vi.fn());
const runPrepassMock = vi.hoisted(() => vi.fn());
const getRunReviewBundleMock = vi.hoisted(() => vi.fn());
const captureCodexCatalogRevisionMock = vi.hoisted(() => vi.fn());
const NATIVE_CODEX_CATALOG_TOKEN =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

vi.mock("./codexCatalogRevision", () => ({
  captureCodexCatalogRevision: captureCodexCatalogRevisionMock,
}));
vi.mock("@/application/narrative-extraction/runRepository", () => ({
  createRun: createRunMock,
  getRun: getRunMock,
  cancelRun: cancelRunMock,
}));
vi.mock("@/application/narrative-extraction/proposalRepository", () => ({
  saveProposalSet: saveProposalSetMock,
  buildNativeReconciliationEnvelope: buildNativeReconciliationEnvelopeMock,
  buildSnapshotSourceBasis: buildSnapshotSourceBasisMock,
  appendDecision: appendDecisionMock,
  appendHumanDecision: appendHumanDecisionMock,
  appendRevision: appendRevisionMock,
  reviseAndDecideAsHuman: reviseAndDecideAsHumanMock,
}));
vi.mock(
  "@/application/narrative-extraction/nativeApi",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/nativeApi")
      >();
    return {
      ...actual,
      captureNarrativeExtractionWorkspaceBinding: captureWorkspaceBindingMock,
      narrativeExtractionClaimTask: claimTaskMock,
      narrativeExtractionFinishTask: finishTaskMock,
      narrativeExtractionFailTask: failTaskMock,
      narrativeExtractionGetRunReviewBundle: getRunReviewBundleMock,
    };
  },
);
vi.mock(
  "@/application/narrative-extraction/codexCommitCoordinator",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/codexCommitCoordinator")
      >();
    return {
      ...actual,
      prepareAndApplyCodexCommit: prepareApplyMock,
    };
  },
);
vi.mock("@/application/narrative-extraction/projectSnapshotAdapter", () => ({
  buildProjectNarrativeSnapshot: buildSnapshotMock,
}));
vi.mock("./extraction/entityCandidatePrepass", () => ({
  runEntityCandidatePrepass: runPrepassMock,
}));

import {
  loadInlineJsonArtifact,
  resetNarrativeArtifactIndexForTests,
} from "@/application/narrative-extraction/artifactRepository";
import {
  bindExistingCodexEntityProposal,
  CODEX_ENTITY_BIND_PROPOSAL_KIND,
  createNewBindCodexEntityProposal,
  unresolvedBindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import {
  CODEX_RELATION_CREATE_PROPOSAL_KIND,
  createCodexRelationProposalFromHypothesis,
} from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import { CODEX_BASE_DETAIL_SET_PROPOSAL_KIND } from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";
import { CODEX_PHASE_BIND_PROPOSAL_KIND } from "@/features/narrative-extraction/proposals/bindCodexPhaseProposal";
import { buildCodexReviewRevisionEnvelope } from "./extraction/reviewRevisionEnvelope";
import { buildCodexRelationSemanticKey } from "./extraction/relationVocabulary";
import {
  applyCodexStructureExtractionReview,
  buildCodexStructureCatalogs,
  buildRelationCoMentionQuote,
  bulkApproveSafeCodexStructureProposals,
  CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
  CODEX_STRUCTURE_PROPOSAL_SET_KIND,
  CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
  decideCodexStructureProposal,
  resetCodexStructureExtractionApiCachesForTests,
  resolveCodexStructureBinding,
  reviseCodexStructureProposal,
  reviseCodexStructureRelation,
  startCodexStructureExtraction,
} from "./codexStructureExtractionApi";
import {
  buildCodexEntityProposalSafetyFlags,
  isSafeForCodexEntityBulkApprove,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
} from "./codexStructureExtractionStore";

function stubNativePersistHappyPath(runId = "native-run-1") {
  createRunMock.mockResolvedValue({
    runId,
    status: "running",
    taskIds: ["t1"],
  });
  claimTaskMock.mockResolvedValue({
    claimed: true,
    task: {
      taskId: "t1",
      runId,
      taskKind: "codex.entity.resolve",
      status: "running",
      inputJson: { stage: 1 },
      attemptId: "attempt-1",
      attemptNumber: 1,
      leaseOwner: "codex-structure-extract",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    },
  });
  finishTaskMock.mockResolvedValue({
    taskId: "t1",
    attemptId: "attempt-1",
    status: "completed",
  });
  getRunMock.mockResolvedValue({
    run: {
      runId,
      projectId: "p1",
      surfacePathId: "codex.structure.extract",
      status: "completed",
    },
    tasks: [],
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
    },
  });
  saveProposalSetMock.mockImplementation(
    async (payload: {
      proposals: readonly {
        proposalKey: string;
        proposalId?: string;
      }[];
    }) => ({
      proposalSetId: "native-ps-1",
      proposals: payload.proposals.map((proposal, index) => ({
        proposalId: proposal.proposalId ?? `native-p-${index + 1}`,
        proposalKey: proposal.proposalKey,
        revisionId: `native-rev-${index + 1}`,
        status: "unreviewed",
      })),
    }),
  );
}

describe("buildCodexStructureCatalogs", () => {
  it("assigns opaque K/T refs while keeping sourceKey/slug for Apply", () => {
    const catalogs = buildCodexStructureCatalogs({
      entries: [
        {
          id: "entry-real",
          name: "ライカ",
          aliases: null,
          type: "character",
          version: 3,
        },
      ],
    });
    expect(catalogs.existingCatalog[0]?.ref).toBe("K0001");
    expect(catalogs.existingCatalog[0]?.sourceKey).toBe("entry-real");
    expect(catalogs.typeCatalog[0]?.ref).toBe("T0001");
    expect(catalogs.typeCatalog[0]?.slug).toBe("character");
  });

  it("uses project-backed custom types in the catalog version vector", () => {
    const catalogs = buildCodexStructureCatalogs({
      projectTypes: [
        { slug: "character", label: "Character" },
        { slug: "faction", label: "Faction" },
      ],
    });
    expect(catalogs.typeCatalog.map((type) => type.sourceKey)).toEqual([
      "character",
      "faction",
    ]);
    expect(catalogs.typeCatalog[1]?.expectedVersion).toBe(1);
  });
});

describe("buildRelationCoMentionQuote", () => {
  it("joins prefix + surface quote + suffix for Relation windows", () => {
    expect(
      buildRelationCoMentionQuote({
        quote: "ライカ",
        context: { prefix: "", suffix: "とベルカは友人だ" },
      }),
    ).toBe("ライカとベルカは友人だ");
  });
});

describe("startCodexStructureExtraction product safety", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    resetCodexStructureExtractionStoreForTests();
    createRunMock.mockReset();
    getRunMock.mockReset();
    cancelRunMock.mockReset();
    saveProposalSetMock.mockReset();
    buildNativeReconciliationEnvelopeMock.mockReset();
    buildSnapshotSourceBasisMock.mockReset();
    claimTaskMock.mockReset();
    finishTaskMock.mockReset();
    failTaskMock.mockReset();
    captureWorkspaceBindingMock.mockReset();
    captureWorkspaceBindingMock.mockResolvedValue({
      authorityId: "workspace-authority-codex",
      generation: 1,
      authorityInstanceId: "1",
    });
    captureCodexCatalogRevisionMock.mockReset();
    captureCodexCatalogRevisionMock.mockImplementation(
      async (input: { projectId: string }) => ({
        sourceKind: "codex-catalog",
        sourceKey: `project:codex-catalog:${input.projectId}`,
        revisionToken: NATIVE_CODEX_CATALOG_TOKEN,
      }),
    );
    prepareApplyMock.mockReset();
    appendDecisionMock.mockReset();
    appendHumanDecisionMock.mockReset();
    appendRevisionMock.mockReset();
    reviseAndDecideAsHumanMock.mockReset();
    buildSnapshotMock.mockReset();
    runPrepassMock.mockReset();
    buildSnapshotSourceBasisMock.mockReturnValue([]);
    buildSnapshotMock.mockResolvedValue({
      ok: true,
      snapshot: {
        digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        documents: [],
      },
      diagnostics: [],
    });
    buildNativeReconciliationEnvelopeMock.mockResolvedValue({
      schemaVersion: 1,
      proposalSchemaId: "test.proposal",
      proposalSchemaVersion: 1,
      sourceBasis: [
        {
          sourceKey: "snapshot:native-run-1",
          sourceKind: "snapshot-document",
          sourceRevisionToken:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      readSet: [
        {
          sourceKey: "snapshot:native-run-1",
          kind: "snapshot-document",
          revisionToken:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      evidenceSet: [
        {
          evidenceRef: "test-evidence",
          method: "exact",
          quoteDigest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
      reconciler: {
        id: "test.reconciler",
        version: 1,
      },
      readSetDigest:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    stubNativePersistHappyPath();
  });

  it("does not invent exact Evidence for heuristic seeds without quotes", async () => {
    const projection = await startCodexStructureExtraction({
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false,
      skipNativePersist: true,
      typeCatalog: [
        {
          ref: "T0001",
          sourceKey: "character",
          slug: "character",
          label: "character",
          coarseClassHints: ["person"],
          expectedVersion: 1,
        },
      ],
      heuristicSeeds: [
        {
          surface: "ライカ",
          typeRef: "T0001",
        },
      ],
    });

    expect(projection.proposals[0]?.evidence[0]?.method).toBe("unknown");
    expect(projection.proposals[0]?.evidence[0]?.blocked).toBe(true);
    expect(
      projection.proposals.some((proposal) =>
        proposal.evidence.some(
          (row) => row.method === "exact" && row.documentRef.startsWith("D"),
        ),
      ),
    ).toBe(false);
  });

  it("returns projection without publishing to the store (Dialog owns setProjection)", async () => {
    const projection = await startCodexStructureExtraction({
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false,
      skipNativePersist: true,
      typeCatalog: [
        {
          ref: "T0001",
          sourceKey: "character",
          slug: "character",
          label: "character",
          coarseClassHints: ["person"],
          expectedVersion: 1,
        },
      ],
      heuristicSeeds: [
        {
          surface: "ライカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカ",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
      ],
    });

    expect(projection.proposals.length).toBeGreaterThan(0);
    expect(useCodexStructureExtractionStore.getState().projection).toBeNull();
  });

  it("persists Native run/proposal revisions when not skipped", async () => {
    const projection = await startCodexStructureExtraction({
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false,
      typeCatalog: [
        {
          ref: "T0001",
          sourceKey: "character",
          slug: "character",
          label: "character",
          coarseClassHints: ["person"],
          expectedVersion: 1,
        },
      ],
      phaseSeeds: [
        {
          entityId: "ne-1",
          anchorDocumentRef: "S000001",
          labelSuggestion: "旅立ち",
          quote: "ライカは旅立った",
        },
      ],
      baseDetailSeeds: [
        {
          entityId: "ne-1",
          facetKey: "role.current",
          definitionRef: "D0001",
          value: { kind: "text", text: "旅人" },
          temporalEligibility: "timeless",
          quote: "ライカは旅人だ",
        },
        {
          entityId: "ne-1",
          facetKey: "status.current",
          value: { kind: "text", text: "未知" },
          temporalEligibility: "timeless",
          unbound: true,
          quote: "ライカの状態は未知だ",
        },
      ],
      heuristicSeeds: [
        {
          surface: "ライカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカは槍を構えた",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
      ],
    });

    const workspaceBinding = {
      authorityId: "workspace-authority-codex",
      generation: 1,
      authorityInstanceId: "1",
    };
    expect(captureWorkspaceBindingMock).toHaveBeenCalledWith("/w");
    expect(createRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
      workspaceBinding,
    );
    expect(saveProposalSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
      workspaceBinding,
    );
    // DR-CSX-1: the codex-catalog Source token is the one Native returned.
    expect(captureCodexCatalogRevisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", binding: workspaceBinding }),
    );
    expect(createRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ catalogDigest: NATIVE_CODEX_CATALOG_TOKEN }),
      workspaceBinding,
    );
    expect(buildNativeReconciliationEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBasis: expect.arrayContaining([
          {
            sourceKind: "codex-catalog",
            sourceKey: "project:codex-catalog:p1",
            revisionToken: NATIVE_CODEX_CATALOG_TOKEN,
          },
        ]),
      }),
    );
    expect(projection.runId).toBe("native-run-1");
    expect(projection.proposalSetId).toBe("native-ps-1");
    expect(projection.proposals[0]?.revisionId).toBe("native-rev-1");
    expect(projection.baseDetailProposals[0]?.revisionId).toBe("native-rev-2");
    expect(projection.baseDetailProposals[0]).toMatchObject({
      applicability: "blocked",
      evidence: [],
    });
    expect(projection.baseDetailProposals[1]).toMatchObject({
      applicability: "blocked",
      evidence: [],
    });
    expect(projection.baseDetailProposals[0]?.evidence).not.toContainEqual(
      expect.objectContaining({ documentRef: expect.stringMatching(/^[BU]/) }),
    );
    expect(projection.phaseProposals[0]?.revisionId).toBe("native-rev-4");
    const savedPayload = saveProposalSetMock.mock.calls[0]?.[0] as {
      proposals: readonly { kind: string }[];
    };
    expect(savedPayload.proposals.map((proposal) => proposal.kind)).toEqual([
      CODEX_ENTITY_BIND_PROPOSAL_KIND,
      CODEX_BASE_DETAIL_SET_PROPOSAL_KIND,
      CODEX_BASE_DETAIL_SET_PROPOSAL_KIND,
      CODEX_PHASE_BIND_PROPOSAL_KIND,
    ]);
    const finishPayload = finishTaskMock.mock.calls[0]?.[0] as {
      artifacts: readonly {
        payloadJson?: {
          baseDetailProposals?: readonly unknown[];
          phaseProposals?: readonly unknown[];
        };
      }[];
    };
    expect(
      finishPayload.artifacts[0]?.payloadJson?.baseDetailProposals,
    ).toHaveLength(2);
    expect(
      finishPayload.artifacts[0]?.payloadJson?.phaseProposals,
    ).toHaveLength(1);
    expect(projection.catalog?.types[0]?.slug).toBe("character");
  });

  it("fails closed when Native persistence has no snapshot revision token", async () => {
    buildSnapshotMock.mockResolvedValue({
      ok: true,
      snapshot: {},
      diagnostics: [],
    });

    await expect(
      startCodexStructureExtraction({
        projectId: "p1",
        folderId: "f1",
        sceneIds: ["s1"],
        authority: {
          projectId: "p1",
          currentProjectId: () => "p1",
          workspacePath: "/w",
          workspaceOpenRevision: 1,
        },
        workspacePath: "/w",
        openRevision: 1,
        useAi: false,
        typeCatalog: [
          {
            ref: "T0001",
            sourceKey: "character",
            slug: "character",
            label: "character",
            coarseClassHints: ["person"],
            expectedVersion: 1,
          },
        ],
        heuristicSeeds: [
          {
            surface: "ライカ",
            typeRef: "T0001",
            evidence: [
              {
                anchorId: "a1",
                quote: "ライカ",
                documentRef: "D000001",
                method: "exact",
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("without a snapshot revision digest");
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it("does not publish the review artifact cache when Native FinishTask rolls back", async () => {
    finishTaskMock.mockRejectedValueOnce(new Error("FinishTask rolled back"));
    failTaskMock.mockResolvedValue({
      taskId: "t1",
      attemptId: "attempt-1",
      status: "failed",
    });

    await expect(
      startCodexStructureExtraction({
        projectId: "p1",
        folderId: "f1",
        sceneIds: ["s1"],
        authority: {
          projectId: "p1",
          currentProjectId: () => "p1",
          workspacePath: "/w",
          workspaceOpenRevision: 1,
        },
        workspacePath: "/w",
        openRevision: 1,
        useAi: false,
        typeCatalog: [
          {
            ref: "T0001",
            sourceKey: "character",
            slug: "character",
            label: "character",
            coarseClassHints: ["person"],
            expectedVersion: 1,
          },
        ],
        heuristicSeeds: [
          {
            surface: "ライカ",
            typeRef: "T0001",
            evidence: [
              {
                anchorId: "a1",
                quote: "ライカ",
                documentRef: "D000001",
                method: "exact",
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("FinishTask rolled back");

    await expect(
      loadInlineJsonArtifact(
        "native-run-1",
        CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
        {
          scope: {
            projectId: "p1",
            workspacePath: "/w",
            workspaceOpenRevision: 1,
          },
        },
      ),
    ).resolves.toBeNull();
  });

  it("derives relation proposals from vocabulary co-mentions in shared quotes", async () => {
    const quote = "ライカとベルカは友人だ";
    const projection = await startCodexStructureExtraction({
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false,
      skipNativePersist: true,
      typeCatalog: [
        {
          ref: "T0001",
          sourceKey: "character",
          slug: "character",
          label: "character",
          coarseClassHints: ["person"],
          expectedVersion: 1,
        },
      ],
      heuristicSeeds: [
        {
          surface: "ライカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote,
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
        {
          surface: "ベルカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a2",
              quote,
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
      ],
    });

    expect(projection.relationProposals.length).toBeGreaterThan(0);
    expect(
      projection.relationProposals.some(
        (item) =>
          item.displayTitle.includes("友人") &&
          item.displayTitle.includes("ライカ") &&
          item.displayTitle.includes("ベルカ"),
      ),
    ).toBe(true);
  });

  it("aggregates multi-anchor friend mentions into one Relation proposal", async () => {
    const projection = await startCodexStructureExtraction({
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false,
      skipNativePersist: true,
      typeCatalog: [
        {
          ref: "T0001",
          sourceKey: "character",
          slug: "character",
          label: "character",
          coarseClassHints: ["person"],
          expectedVersion: 1,
        },
      ],
      heuristicSeeds: [
        {
          surface: "ライカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカとベルカは友人だ。",
              documentRef: "D000001",
              method: "exact",
            },
            {
              anchorId: "a2",
              quote: "その後もライカとベルカは友人であり続けた。",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
        {
          surface: "ベルカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカとベルカは友人だ。",
              documentRef: "D000001",
              method: "exact",
            },
            {
              anchorId: "a2",
              quote: "その後もライカとベルカは友人であり続けた。",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
      ],
    });

    const friends = projection.relationProposals.filter((item) =>
      item.displayTitle.includes("友人"),
    );
    expect(friends).toHaveLength(1);
    expect(friends[0]?.evidence).toHaveLength(2);
    expect(friends[0]?.evidence.map((row) => row.anchorId).sort()).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("persists stable proposalIds and immutable relationDependencies in summaryJson", async () => {
    await startCodexStructureExtraction({
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false,
      typeCatalog: [
        {
          ref: "T0001",
          sourceKey: "character",
          slug: "character",
          label: "character",
          coarseClassHints: ["person"],
          expectedVersion: 1,
        },
      ],
      heuristicSeeds: [
        {
          surface: "ライカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカとベルカは友人だ",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
        {
          surface: "ベルカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカとベルカは友人だ",
              documentRef: "D000001",
              method: "exact",
            },
          ],
        },
      ],
    });

    expect(saveProposalSetMock).toHaveBeenCalled();
    expect(claimTaskMock).toHaveBeenCalled();
    expect(finishTaskMock).toHaveBeenCalled();
    const finishPayload = finishTaskMock.mock.calls[0]?.[0] as {
      artifacts?: readonly { artifactKind: string }[];
    };
    expect(finishPayload.artifacts?.[0]?.artifactKind).toBe(
      "codex.structure.review-projection@1",
    );
    expect(getRunMock).toHaveBeenCalledWith("native-run-1", "p1");
    const payload = saveProposalSetMock.mock.calls[0]?.[0] as {
      summaryJson: {
        relationDependencies: Record<string, readonly { proposalId: string }[]>;
      };
      proposals: readonly {
        proposalId: string;
        kind: string;
        payloadJson: Record<string, unknown>;
      }[];
    };
    expect(
      payload.proposals.every((row) => typeof row.proposalId === "string"),
    ).toBe(true);
    expect(
      payload.proposals.every((row) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          row.proposalId,
        ),
      ),
    ).toBe(true);
    const relation = payload.proposals.find((row) =>
      row.kind.includes("relation"),
    );
    expect(relation).toBeDefined();
    expect(relation?.payloadJson.dependencies).toBeUndefined();
    const deps = payload.summaryJson.relationDependencies[relation!.proposalId];
    expect(deps?.length).toBe(2);
    const entityIds = new Set(
      payload.proposals
        .filter((row) => !row.kind.includes("relation"))
        .map((row) => row.proposalId),
    );
    for (const dep of deps ?? []) {
      expect(entityIds.has(dep.proposalId)).toBe(true);
    }
  });

  it("uses unique proposalIds across consecutive runs (no codex-bind-N collision)", async () => {
    const request = {
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false as const,
      typeCatalog: [
        {
          ref: "T0001",
          sourceKey: "character",
          slug: "character",
          label: "character",
          coarseClassHints: ["person" as const],
          expectedVersion: 1,
        },
      ],
      heuristicSeeds: [
        {
          surface: "ライカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカとベルカは友人だ",
              documentRef: "D000001",
              method: "exact" as const,
            },
          ],
        },
        {
          surface: "ベルカ",
          typeRef: "T0001",
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカとベルカは友人だ",
              documentRef: "D000001",
              method: "exact" as const,
            },
          ],
        },
      ],
    };

    stubNativePersistHappyPath("native-run-a");
    await startCodexStructureExtraction(request);
    stubNativePersistHappyPath("native-run-b");
    await startCodexStructureExtraction(request);

    const firstIds = (
      saveProposalSetMock.mock.calls[0]?.[0] as {
        proposals: readonly { proposalId: string }[];
      }
    ).proposals.map((row) => row.proposalId);
    const secondIds = (
      saveProposalSetMock.mock.calls[1]?.[0] as {
        proposals: readonly { proposalId: string }[];
      }
    ).proposals.map((row) => row.proposalId);
    expect(firstIds.length).toBeGreaterThan(0);
    expect(secondIds.length).toBeGreaterThan(0);
    const overlap = firstIds.filter((id) => secondIds.includes(id));
    expect(overlap).toEqual([]);
  });

  it("derives Relation proposals from prepass context windows without heuristicSeeds", async () => {
    const { buildNarrativeCorpusSnapshot } =
      await import("@/features/narrative-extraction/source/buildSnapshot");
    const snapshotResult = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-product-path",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "p1" },
      omissions: [],
      createdAt: "2026-08-10T00:01:00.000Z",
      documents: [
        {
          sourceKey: "project:scene:s1",
          parentSourceKey: null,
          title: "Scene",
          orderIndex: 0,
          proseMirrorJson: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "ライカとベルカは友人だ" }],
              },
            ],
          }),
          origin: {
            kind: "project-node",
            projectId: "p1",
            nodeId: "s1",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
    });
    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) return;
    const documentRef = snapshotResult.snapshot.documents[0]!.ref;

    buildSnapshotMock.mockResolvedValue({
      ok: true,
      snapshot: snapshotResult.snapshot,
      diagnostics: [],
    });
    runPrepassMock.mockResolvedValue({
      status: "complete",
      seeds: [
        {
          seedId: "seed-laika",
          surface: "ライカ",
          normalizedSurface: "ライカ",
          features: {
            occurrenceCount: 1,
            appearsAsProperName: true,
            appearsInDialogue: false,
            appearsInNarration: true,
          },
          occurrences: [
            {
              sourceRef: "S0001",
              documentRef,
              quote: "ライカ",
              canonicalRange: { start: 0, end: 3 },
              context: { prefix: "", suffix: "とベルカは友人だ" },
              evidence: {
                id: "ea-laika",
                quote: "ライカ",
                documentRef,
                method: "exact",
              },
            },
          ],
        },
        {
          seedId: "seed-belka",
          surface: "ベルカ",
          normalizedSurface: "ベルカ",
          features: {
            occurrenceCount: 1,
            appearsAsProperName: true,
            appearsInDialogue: false,
            appearsInNarration: true,
          },
          occurrences: [
            {
              sourceRef: "S0001",
              documentRef,
              quote: "ベルカ",
              canonicalRange: { start: 4, end: 7 },
              context: { prefix: "ライカと", suffix: "は友人だ" },
              evidence: {
                id: "ea-belka",
                quote: "ベルカ",
                documentRef,
                method: "exact",
              },
            },
          ],
        },
      ],
      rejections: [],
    });

    const projection = await startCodexStructureExtraction({
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false,
      skipNativePersist: true,
      typeCatalog: [
        {
          ref: "T0001",
          sourceKey: "character",
          slug: "character",
          label: "character",
          coarseClassHints: ["person"],
          expectedVersion: 1,
        },
      ],
    });

    expect(projection.proposals).toHaveLength(2);
    expect(
      projection.proposals.every(
        (row) => row.evidence[0]?.quote === row.displayTitle,
      ),
    ).toBe(true);
    expect(projection.relationProposals.length).toBeGreaterThan(0);
    expect(
      projection.relationProposals.some(
        (item) =>
          item.displayTitle.includes("友人") &&
          item.evidence.some((row) => row.quote.includes("友人")),
      ),
    ).toBe(true);
  }, 15_000);

  it("does not propose relational terms as new people and reports what it skipped", async () => {
    const { buildNarrativeCorpusSnapshot } =
      await import("@/features/narrative-extraction/source/buildSnapshot");
    const snapshotResult = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-relational-terms",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "p1" },
      omissions: [],
      createdAt: "2026-08-10T00:01:00.000Z",
      documents: [
        {
          sourceKey: "project:scene:s1",
          parentSourceKey: null,
          title: "Scene",
          orderIndex: 0,
          proseMirrorJson: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "姉ちゃんとダンナとおじいさんとライカ",
                  },
                ],
              },
            ],
          }),
          origin: {
            kind: "project-node",
            projectId: "p1",
            nodeId: "s1",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
    });
    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) return;
    const documentRef = snapshotResult.snapshot.documents[0]!.ref;
    buildSnapshotMock.mockResolvedValue({
      ok: true,
      snapshot: snapshotResult.snapshot,
      diagnostics: [],
    });
    const prepassSeed = (surface: string, start: number) => ({
      seedId: `seed-${surface}`,
      surface,
      normalizedSurface: surface,
      features: {
        occurrenceCount: 1,
        appearsAsProperName: true,
        appearsInDialogue: false,
        appearsInNarration: true,
      },
      occurrences: [
        {
          sourceRef: "S0001",
          documentRef,
          quote: surface,
          canonicalRange: { start, end: start + surface.length },
          context: { prefix: "", suffix: "" },
          evidence: {
            id: `ea-${surface}`,
            quote: surface,
            documentRef,
            method: "exact",
          },
        },
      ],
    });
    runPrepassMock.mockResolvedValue({
      status: "complete",
      seeds: [
        prepassSeed("姉ちゃん", 0),
        prepassSeed("ダンナ", 5),
        prepassSeed("おじいさん", 9),
        prepassSeed("ライカ", 14),
      ],
      rejections: [],
    });

    const projection = await startCodexStructureExtraction({
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false,
      skipNativePersist: true,
      existingEntries: [
        {
          ref: "K0001",
          sourceKey: "db:husband",
          name: "ベルカ",
          aliases: ["ダンナ"],
          typeRef: "T0001",
          expectedVersion: 1,
        },
      ],
      typeCatalog: [
        {
          ref: "T0001",
          sourceKey: "character",
          slug: "character",
          label: "character",
          coarseClassHints: ["person"],
          expectedVersion: 1,
        },
      ],
    });

    const titles = projection.proposals.map((row) => row.displayTitle);
    expect(titles).toContain("ライカ");
    expect(titles).toContain("ダンナ");
    expect(titles).not.toContain("姉ちゃん");
    expect(titles).not.toContain("おじいさん");
    const danna = projection.proposals.find(
      (row) => row.displayTitle === "ダンナ",
    );
    expect(danna?.proposal.payload.binding.kind).toBe("bind-existing");
    expect(projection.skippedRelationalTerms).toEqual([
      { surface: "姉ちゃん", kind: "kinship" },
      { surface: "おじいさん", kind: "kinship" },
    ]);
  }, 15_000);

  it("omits the skipped-terms diagnostic when no relational term was skipped", async () => {
    const { buildNarrativeCorpusSnapshot } =
      await import("@/features/narrative-extraction/source/buildSnapshot");
    const snapshotResult = await buildNarrativeCorpusSnapshot({
      snapshotId: "snapshot-no-relational",
      language: "ja",
      origin: { kind: "grimodex-project", projectId: "p1" },
      omissions: [],
      createdAt: "2026-08-10T00:01:00.000Z",
      documents: [
        {
          sourceKey: "project:scene:s1",
          parentSourceKey: null,
          title: "Scene",
          orderIndex: 0,
          proseMirrorJson: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "ライカとライカ嬢" }],
              },
            ],
          }),
          origin: {
            kind: "project-node",
            projectId: "p1",
            nodeId: "s1",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ],
    });
    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) return;
    const documentRef = snapshotResult.snapshot.documents[0]!.ref;
    buildSnapshotMock.mockResolvedValue({
      ok: true,
      snapshot: snapshotResult.snapshot,
      diagnostics: [],
    });
    runPrepassMock.mockResolvedValue({
      status: "complete",
      seeds: [
        {
          seedId: "seed-laika",
          surface: "ライカ",
          normalizedSurface: "ライカ",
          features: {
            occurrenceCount: 1,
            appearsAsProperName: true,
            appearsInDialogue: false,
            appearsInNarration: true,
          },
          occurrences: [
            {
              sourceRef: "S0001",
              documentRef,
              quote: "ライカ",
              canonicalRange: { start: 0, end: 3 },
              context: { prefix: "", suffix: "" },
              evidence: {
                id: "ea-laika",
                quote: "ライカ",
                documentRef,
                method: "exact",
              },
            },
          ],
        },
      ],
      rejections: [],
    });
    const projection = await startCodexStructureExtraction({
      projectId: "p1",
      folderId: "f1",
      sceneIds: ["s1"],
      authority: {
        projectId: "p1",
        currentProjectId: () => "p1",
        workspacePath: "/w",
        workspaceOpenRevision: 1,
      },
      workspacePath: "/w",
      openRevision: 1,
      useAi: false,
      skipNativePersist: true,
    });
    expect(projection.proposals.map((row) => row.displayTitle)).toEqual([
      "ライカ",
    ]);
    expect(projection.skippedRelationalTerms).toBeUndefined();
  });

  it("live の結び付けの提案に existingExactBind の旗が立ち、別名の追加がある結び付けには立たない", async () => {
    const start = (
      seeds: Parameters<
        typeof startCodexStructureExtraction
      >[0]["heuristicSeeds"],
    ) =>
      startCodexStructureExtraction({
        projectId: "p1",
        folderId: "f1",
        sceneIds: ["s1"],
        authority: {
          projectId: "p1",
          currentProjectId: () => "p1",
          workspacePath: "/w",
          workspaceOpenRevision: 1,
        },
        workspacePath: "/w",
        openRevision: 1,
        useAi: false,
        skipNativePersist: true,
        typeCatalog: [
          {
            ref: "T0001",
            sourceKey: "character",
            slug: "character",
            label: "character",
            coarseClassHints: ["person"],
            expectedVersion: 1,
          },
        ],
        existingEntries: [
          {
            ref: "K0003",
            sourceKey: "entry-riku",
            name: "リク",
            aliases: [],
            typeRef: "T0001",
            expectedVersion: 4,
          },
        ],
        heuristicSeeds: seeds,
      });
    const exactEvidence = [
      {
        anchorId: "a1",
        quote: "リク",
        documentRef: "D000001",
        method: "exact" as const,
      },
    ];
    const plain = await start([
      {
        surface: "リク",
        typeRef: "T0001",
        existingRef: "K0003",
        evidence: exactEvidence,
      },
    ]);
    expect(plain.proposals[0]?.proposal.payload.binding.kind).toBe(
      "bind-existing",
    );
    expect(plain.proposals[0]?.safety.existingExactBind).toBe(true);
    expect(isSafeForCodexEntityBulkApprove(plain.proposals[0]!.safety)).toBe(
      true,
    );

    const withAlias = await start([
      {
        surface: "リク",
        typeRef: "T0001",
        existingRef: "K0003",
        aliases: [{ surface: "りっくん", status: "explicit" }],
        evidence: exactEvidence,
      },
    ]);
    expect(withAlias.proposals[0]?.safety.existingExactBind).toBe(false);
    expect(
      isSafeForCodexEntityBulkApprove(withAlias.proposals[0]!.safety),
    ).toBe(false);
  });
});

describe("bulkApproveSafeCodexStructureProposals", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    appendDecisionMock.mockReset();
    appendHumanDecisionMock.mockReset();
    appendRevisionMock.mockReset();
    reviseAndDecideAsHumanMock.mockReset();
    reviseAndDecideAsHumanMock.mockResolvedValue({
      proposalId: "safe",
      revisionId: "rev-2",
      revisionNumber: 2,
      decisionId: "d1",
      decision: "approved",
      status: "approved",
    });
  });

  it("persists Native revision + decision instead of local-only status flip", async () => {
    const bind = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-1",
        canonicalName: "ライカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "ライカ", aliases: [], summary: "騎士" },
        },
      },
      { proposalId: "safe" },
    );
    const safeProposal = {
      proposalId: "safe",
      revisionId: "rev-1",
      proposalKey: "h1",
      status: "unreviewed" as const,
      applicability: "applicable" as const,
      displayTitle: "ライカ",
      proposal: bind,
      evidence: [
        {
          anchorId: "a1",
          quote: "ライカ",
          documentRef: "D1",
          method: "exact" as const,
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
    };

    useCodexStructureExtractionStore.getState().setProjection({
      runId: "run-1",
      projectId: "p1",
      workspacePath: "/w",
      openRevision: 1,
      proposalSetId: "ps-1",
      status: "completed",
      coverage: {
        mode: "complete",
        documentCount: 1,
        windowCount: 1,
        completedWindows: 1,
        gaps: [],
      },
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
      proposals: [safeProposal],
      relationProposals: [],
      baseDetailProposals: [],
      phaseProposals: [],
      catalog: {
        entities: [],
        types: [
          {
            ref: "T0001",
            sourceKey: "character",
            slug: "character",
            label: "character",
          },
        ],
      },
      entityCount: 1,
      relationCount: 0,
      baseDetailCount: 0,
      phaseCount: 0,
      unresolvedCount: 1,
      approvedCount: 0,
    });

    const result = await bulkApproveSafeCodexStructureProposals();
    expect(result.approved).toBe(1);
    expect(result.failed).toEqual([]);
    // Approve is a single atomic revision + decision transaction now.
    expect(appendRevisionMock).not.toHaveBeenCalled();
    expect(appendDecisionMock).not.toHaveBeenCalled();
    expect(reviseAndDecideAsHumanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "safe",
        decision: "approved",
        expectedCurrentRevisionId: "rev-1",
      }),
    );
    expect(
      useCodexStructureExtractionStore.getState().projection?.proposals[0]
        ?.status,
    ).toBe("approved");
    expect(
      useCodexStructureExtractionStore.getState().projection?.proposals[0]
        ?.compiledOperation,
    ).toBeTruthy();
  });

  describe("完全一致の既存への結び付け", () => {
    const BIND_CATALOG = {
      entities: [
        {
          ref: "K0003",
          sourceKey: "entry-riku",
          name: "リク",
          typeRef: "T0001",
          expectedVersion: 1,
          aliases: [] as string[],
        },
        {
          ref: "K0005",
          sourceKey: "entry-sora",
          name: "ソラ",
          typeRef: "T0001",
          expectedVersion: 1,
          aliases: [] as string[],
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
    };
    const LIVE_ENTRIES = [
      {
        id: "entry-riku",
        name: "リク",
        aliases: null,
        type: "character",
        version: 7,
      },
      {
        id: "entry-sora",
        name: "ソラ",
        aliases: null,
        type: "character",
        version: 2,
      },
    ];
    const evidence = [
      {
        anchorId: "a1",
        quote: "リク",
        documentRef: "D1",
        method: "exact" as const,
      },
    ];

    function bindRow(
      proposalId: string,
      name: string,
      entityRef: string,
      narrativeEntityId: string,
    ) {
      return {
        proposalId,
        revisionId: `rev-${proposalId}`,
        proposalKey: `key-${proposalId}`,
        status: "unreviewed" as const,
        applicability: "applicable" as const,
        displayTitle: name,
        proposal: bindExistingCodexEntityProposal(
          {
            narrativeEntityId,
            canonicalName: name,
            aliases: [],
            coarseClass: "person",
            typeResolution: { status: "resolved", typeRef: "T0001" },
            binding: {
              kind: "bind-existing",
              entityRef,
              enrichment: { aliasesToAdd: [], summary: { kind: "leave" } },
            },
          },
          { proposalId },
        ),
        evidence,
        safety: buildCodexEntityProposalSafetyFlags({
          bindingKind: "bind-existing",
          typeStatus: "resolved",
          evidenceMethods: ["exact"],
          hasExistingCandidates: true,
          hasProperNameMention: true,
          aliasesAllExplicit: true,
        }),
      };
    }

    function createRow(proposalId: string, name: string) {
      return {
        proposalId,
        revisionId: `rev-${proposalId}`,
        proposalKey: `key-${proposalId}`,
        status: "unreviewed" as const,
        applicability: "applicable" as const,
        displayTitle: name,
        proposal: createNewBindCodexEntityProposal(
          {
            narrativeEntityId: `ne-${proposalId}`,
            canonicalName: name,
            aliases: [],
            coarseClass: "person",
            typeResolution: { status: "resolved", typeRef: "T0001" },
            binding: {
              kind: "create-new",
              entry: { name, aliases: [], summary: null },
            },
          },
          { proposalId },
        ),
        evidence,
        safety: buildCodexEntityProposalSafetyFlags({
          bindingKind: "create-new",
          typeStatus: "resolved",
          evidenceMethods: ["exact"],
          hasExistingCandidates: false,
          hasProperNameMention: true,
          aliasesAllExplicit: true,
        }),
      };
    }

    function publish(
      proposals: ReturnType<typeof bindRow | typeof createRow>[],
    ) {
      useCodexStructureExtractionStore.getState().setProjection({
        runId: "run-1",
        projectId: "p1",
        workspacePath: "/w",
        openRevision: 1,
        proposalSetId: "ps-1",
        status: "completed",
        coverage: {
          mode: "complete",
          documentCount: 1,
          windowCount: 1,
          completedWindows: 1,
          gaps: [],
        },
        taskCounts: {
          queued: 0,
          running: 0,
          completed: 1,
          failed: 0,
          cancelled: 0,
        },
        proposals,
        relationProposals: [],
        baseDetailProposals: [],
        phaseProposals: [],
        catalog: BIND_CATALOG,
        entityCount: proposals.length,
        relationCount: 0,
        baseDetailCount: 0,
        phaseCount: 0,
        unresolvedCount: proposals.length,
        approvedCount: 0,
      });
    }

    const stored = (id: string) =>
      useCodexStructureExtractionStore
        .getState()
        .projection?.proposals.find((row) => row.proposalId === id);

    it("新規作成と結び付けを一緒に通し、件数を分けて数え、結び付けの op は今の版で固定して decisionJson に印を残す", async () => {
      publish([
        createRow("c1", "ミナ"),
        bindRow("b1", "リク", "K0003", "ne-b1"),
      ]);
      const result = await bulkApproveSafeCodexStructureProposals({
        entries: LIVE_ENTRIES,
      });
      expect(result).toMatchObject({
        approved: 2,
        approvedCreateNew: 1,
        approvedBindExisting: 1,
        failed: [],
        excluded: [],
      });
      const bindCall = reviseAndDecideAsHumanMock.mock.calls.find(
        ([payload]) => payload.proposalId === "b1",
      )?.[0];
      expect(bindCall.decisionJson).toEqual({ source: "bulk-exact-bind" });
      const createCall = reviseAndDecideAsHumanMock.mock.calls.find(
        ([payload]) => payload.proposalId === "c1",
      )?.[0];
      expect(createCall.decisionJson).toBeUndefined();
      expect(stored("b1")?.compiledOperation).toEqual({
        kind: "codex.entity.bind-existing",
        payload: {
          entryId: "entry-riku",
          narrativeEntityId: "ne-b1",
          // run 時点の catalog（1）でなく、今の Codex の版（7）で固定する。
          baseVersion: 7,
        },
      });
      expect(stored("b1")?.bulkApprovedExactBind).toBe(true);
      expect(stored("c1")?.bulkApprovedExactBind).toBe(false);
    });

    it("run の後に同名の別 Entry が足されていたら結び付けを外して報告し、新規作成は通す", async () => {
      publish([
        createRow("c1", "ミナ"),
        bindRow("b1", "リク", "K0003", "ne-b1"),
        bindRow("b2", "ソラ", "K0005", "ne-b2"),
      ]);
      const result = await bulkApproveSafeCodexStructureProposals({
        entries: [
          ...LIVE_ENTRIES,
          {
            id: "entry-new",
            name: "リク",
            aliases: null,
            type: "character",
            version: 1,
          },
        ],
      });
      expect(result.approvedCreateNew).toBe(1);
      expect(result.approvedBindExisting).toBe(1);
      expect(result.excluded).toEqual([
        { proposalId: "b1", reason: "multiple-exact" },
      ]);
      expect(stored("b1")?.status).toBe("unreviewed");
      expect(stored("b2")?.status).toBe("approved");
    });

    it("結び先が今の Codex で改名・型変更・削除されていたら外す", async () => {
      publish([
        bindRow("b1", "リク", "K0003", "ne-b1"),
        bindRow("b2", "ソラ", "K0005", "ne-b2"),
      ]);
      const result = await bulkApproveSafeCodexStructureProposals({
        entries: [
          { ...LIVE_ENTRIES[0]!, name: "リクト" },
          // ソラは削除（entries に無い）
        ],
      });
      expect(result.approved).toBe(0);
      expect(result.excluded).toEqual([
        { proposalId: "b1", reason: "no-exact-match" },
        { proposalId: "b2", reason: "target-missing" },
      ]);
    });

    it("今の Codex を読めなければ結び付けだけ外し、新規作成は通して報告する", async () => {
      publish([
        createRow("c1", "ミナ"),
        bindRow("b1", "リク", "K0003", "ne-b1"),
      ]);
      const result = await bulkApproveSafeCodexStructureProposals({
        readEntries: async () => {
          throw new Error("db unavailable");
        },
      });
      expect(result.approvedCreateNew).toBe(1);
      expect(result.approvedBindExisting).toBe(0);
      expect(result.excluded).toEqual([
        { proposalId: "b1", reason: "codex-unreadable" },
      ]);
    });

    it("承認の直前に最新の projection から旗を引き直す（途中の編集で対象外になった結び付けは通さない）", async () => {
      publish([
        bindRow("b1", "リク", "K0003", "ne-b1"),
        bindRow("b2", "ソラ", "K0005", "ne-b2"),
      ]);
      reviseAndDecideAsHumanMock.mockImplementationOnce(async () => {
        // 1 件目の承認の途中で、2 件目に要約が足された（patch になる）。
        useCodexStructureExtractionStore
          .getState()
          .reviseProposalFields("b2", { summary: "少年" });
        return {
          proposalId: "b1",
          revisionId: "rev-2",
          revisionNumber: 2,
          decisionId: "d1",
          decision: "approved",
          status: "approved",
        };
      });
      const result = await bulkApproveSafeCodexStructureProposals({
        entries: LIVE_ENTRIES,
      });
      expect(result.approvedBindExisting).toBe(1);
      expect(result.excluded).toEqual([
        { proposalId: "b2", reason: "no-longer-safe" },
      ]);
      expect(stored("b2")?.status).toBe("unreviewed");
    });

    it("手で承認し直した結び付けには、一括の印を付けない", async () => {
      publish([bindRow("b1", "リク", "K0003", "ne-b1")]);
      await bulkApproveSafeCodexStructureProposals({ entries: LIVE_ENTRIES });
      expect(stored("b1")?.bulkApprovedExactBind).toBe(true);
      await decideCodexStructureProposal({
        proposalId: "b1",
        status: "approved",
        entries: LIVE_ENTRIES,
      });
      expect(stored("b1")?.bulkApprovedExactBind).toBe(false);
    });
  });
});

describe("reviseCodexStructureProposal concurrency", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    appendRevisionMock.mockReset();
    appendHumanDecisionMock.mockReset();
  });

  function seedEditableEntity() {
    const proposal = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-1",
        canonicalName: "ライカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "ライカ", aliases: [], summary: null },
        },
      },
      { proposalId: "prop-edit" },
    );
    useCodexStructureExtractionStore.getState().setProjection({
      runId: "run-edit",
      projectId: "p1",
      workspacePath: "/w",
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
      proposals: [
        {
          proposalId: "prop-edit",
          revisionId: "rev-1",
          proposalKey: "ne-1",
          status: "unreviewed",
          applicability: "applicable",
          displayTitle: "ライカ",
          proposal,
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカ",
              documentRef: "D1",
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
        },
      ],
      relationProposals: [],
      baseDetailProposals: [],
      phaseProposals: [],
      entityCount: 1,
      relationCount: 0,
      baseDetailCount: 0,
      phaseCount: 0,
      unresolvedCount: 0,
      approvedCount: 0,
      catalog: { entities: [], types: [] },
    });
  }

  it("keeps first successful revision when a later queued edit fails", async () => {
    seedEditableEntity();
    appendRevisionMock
      .mockResolvedValueOnce({ revisionId: "rev-2" })
      .mockRejectedValueOnce(new Error("NEX_PROPOSAL_REVISION_CONFLICT"));

    const first = reviseCodexStructureProposal({
      proposalId: "prop-edit",
      patch: { canonicalName: "灰の目" },
    });
    const second = reviseCodexStructureProposal({
      proposalId: "prop-edit",
      patch: { summary: "監察官" },
    });

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow(/NEX_PROPOSAL_REVISION_CONFLICT/);

    const row =
      useCodexStructureExtractionStore.getState().projection?.proposals[0];
    expect(row?.revisionId).toBe("rev-2");
    expect(row?.displayTitle).toBe("灰の目");
    expect(row?.proposal.payload.canonicalName).toBe("灰の目");
  });

  it("does not resurrect cleared projection when a late edit fails after folder change", async () => {
    seedEditableEntity();
    let release: ((value: { revisionId: string }) => void) | undefined;
    appendRevisionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = reviseCodexStructureProposal({
      proposalId: "prop-edit",
      patch: { canonicalName: "灰の目" },
    });

    // Wait until Native appendRevision is in-flight (release captured).
    await vi.waitFor(() => {
      expect(release).toEqual(expect.any(Function));
    });

    // Folder change clears projection while Native is still in flight.
    resetCodexStructureExtractionStoreForTests();
    release!({ revisionId: "rev-2" });
    await expect(pending).resolves.toBeUndefined();
    expect(useCodexStructureExtractionStore.getState().projection).toBeNull();
  });

  it("forceNative-resyncs Store to Native rev after appendRevision response loss", async () => {
    resetNarrativeArtifactIndexForTests();
    getRunReviewBundleMock.mockReset();
    seedEditableEntity();
    // live の診断（関係の呼び名の除外）は Native に無く、resync で消えてはいけない。
    const seeded = useCodexStructureExtractionStore.getState().projection!;
    useCodexStructureExtractionStore.getState().setProjection({
      ...seeded,
      skippedRelationalTerms: [{ surface: "姉ちゃん", kind: "kinship" }],
    });

    const nativePayload = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-1",
        canonicalName: "灰の目",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "灰の目", aliases: [], summary: null },
        },
      },
      { proposalId: "prop-edit" },
    ).payload;

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-edit",
        projectId: "p1",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-a" },
        status: "completed",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "t",
        startedAt: null,
        completedAt: null,
        version: 0,
      },
      tasks: [],
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-edit",
      projectId: "p1",
      artifacts: [
        {
          artifactId: "art-resync",
          runId: "run-edit",
          taskId: "t1",
          attemptId: "a1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "ps-1",
            evidenceByProposalId: {
              "prop-edit": [
                {
                  anchorId: "a1",
                  quote: "ライカ",
                  documentRef: "D1",
                  method: "exact",
                },
              ],
            },
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "t",
        },
      ],
      proposalSet: {
        proposalSetId: "ps-1",
        runId: "run-edit",
        projectId: "p1",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
          proposalCount: 1,
          catalog: { entities: [], types: [] },
          existingRelations: [],
          relationDependencies: {},
        },
        createdAt: "t",
        updatedAt: "t",
        version: 0,
      },
      proposals: [
        {
          proposalId: "prop-edit",
          proposalSetId: "ps-1",
          proposalKey: "ne-1",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: nativePayload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-2",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: null,
        },
      ],
    });

    // Native committed rev2, but the IPC Promise rejects (response loss).
    appendRevisionMock.mockRejectedValueOnce(new Error("IPC timeout"));

    await expect(
      reviseCodexStructureProposal({
        proposalId: "prop-edit",
        patch: { canonicalName: "灰の目" },
      }),
    ).rejects.toThrow("IPC timeout");

    expect(getRunReviewBundleMock).toHaveBeenCalled();
    const row =
      useCodexStructureExtractionStore.getState().projection?.proposals[0];
    expect(row?.revisionId).toBe("rev-2");
    expect(row?.displayTitle).toBe("灰の目");
    expect(row?.proposal.payload.canonicalName).toBe("灰の目");
    expect(
      useCodexStructureExtractionStore.getState().projection
        ?.skippedRelationalTerms,
    ).toEqual([{ surface: "姉ちゃん", kind: "kinship" }]);
  });

  it("serializes decide and revise on the same proposal queue", async () => {
    seedEditableEntity();
    const order: string[] = [];
    let releaseDecision: (() => void) | undefined;
    appendHumanDecisionMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          order.push("decision-start");
          releaseDecision = () => {
            order.push("decision-end");
            resolve();
          };
        }),
    );
    appendRevisionMock.mockImplementationOnce(async () => {
      order.push("revision");
      return { revisionId: "rev-2" };
    });

    const decidePending = decideCodexStructureProposal({
      proposalId: "prop-edit",
      status: "rejected",
      kind: "entity",
    });
    const revisePending = reviseCodexStructureProposal({
      proposalId: "prop-edit",
      patch: { canonicalName: "灰の目" },
    });

    await vi.waitFor(() => {
      expect(releaseDecision).toEqual(expect.any(Function));
    });
    expect(appendRevisionMock).not.toHaveBeenCalled();

    releaseDecision!();
    await expect(decidePending).resolves.toBeUndefined();
    await expect(revisePending).resolves.toBeUndefined();

    expect(order).toEqual(["decision-start", "decision-end", "revision"]);
    const row =
      useCodexStructureExtractionStore.getState().projection?.proposals[0];
    expect(row?.revisionId).toBe("rev-2");
    expect(row?.displayTitle).toBe("灰の目");
    // Reject published first; revise resets status to unreviewed after Native revision.
    expect(row?.status).toBe("unreviewed");
  });
});

describe("already-satisfied Relation auto-decision queue", () => {
  const safety = buildCodexEntityProposalSafetyFlags({
    bindingKind: "create-new",
    typeStatus: "resolved",
    evidenceMethods: ["exact"],
    hasExistingCandidates: true,
    hasProperNameMention: true,
    aliasesAllExplicit: true,
  });

  function seedBindingRematchProjection() {
    const left = bindExistingCodexEntityProposal(
      {
        narrativeEntityId: "ne-1",
        canonicalName: "ライカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "bind-existing",
          entityRef: "K0001",
          enrichment: {
            aliasesToAdd: [],
            summary: { kind: "leave" },
          },
        },
      },
      { proposalId: "ent-1" },
    );
    const right = unresolvedBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-2",
        canonicalName: "ベルカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "unresolved",
          candidates: [{ ref: "K0002", score: 0.9, methods: ["exact-name"] }],
          allowCreateNew: true,
        },
      },
      { proposalId: "ent-2" },
    );
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
      projectId: "p1",
      fromCodexId: "entry-laika",
      toCodexId: "entry-belka",
      relationType: "friend_of",
      directionality: "symmetric",
      forwardLabel: "友人",
      inverseLabel: "友人",
    });

    useCodexStructureExtractionStore.getState().setProjection({
      runId: "run-auto",
      projectId: "p1",
      workspacePath: "/w",
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
      proposals: [
        {
          proposalId: "ent-1",
          revisionId: "rev-e1",
          proposalKey: "ne-1",
          status: "approved",
          applicability: "applicable",
          displayTitle: "ライカ",
          proposal: left,
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカ",
              documentRef: "D1",
              method: "exact",
            },
          ],
          safety,
        },
        {
          proposalId: "ent-2",
          revisionId: "rev-e2",
          proposalKey: "ne-2",
          status: "unreviewed",
          applicability: "applicable",
          displayTitle: "ベルカ",
          proposal: right,
          evidence: [
            {
              anchorId: "a2",
              quote: "ベルカ",
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
        },
      ],
      relationProposals: [
        {
          proposalId: "rel-1",
          revisionId: "rev-rel-1",
          proposalKey: "rel-key",
          status: "unreviewed",
          applicability: "blocked",
          displayTitle: "ライカ → 友人 → ベルカ",
          proposal: relationProposal,
          evidence: [
            {
              anchorId: "a3",
              quote: "友人",
              documentRef: "D1",
              method: "exact",
            },
          ],
          subjectLabel: "ライカ",
          objectLabel: "ベルカ",
          blockedReason: "先に両端の Entity proposal を承認してください",
        },
      ],
      entityCount: 2,
      relationCount: 1,
      baseDetailProposals: [],
      phaseProposals: [],
      baseDetailCount: 0,
      phaseCount: 0,
      unresolvedCount: 1,
      approvedCount: 1,
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
    });
  }

  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    appendRevisionMock.mockReset();
    appendDecisionMock.mockReset();
  });

  it("serializes auto already-satisfied decision ahead of Relation revise", async () => {
    seedBindingRematchProjection();
    const order: string[] = [];
    let releaseDecision: (() => void) | undefined;

    appendRevisionMock.mockResolvedValueOnce({ revisionId: "rev-e2b" });
    appendDecisionMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          order.push("auto-decision-start");
          releaseDecision = () => {
            order.push("auto-decision-end");
            resolve();
          };
        }),
    );

    const bindingPending = resolveCodexStructureBinding({
      proposalId: "ent-2",
      resolution: { kind: "bind-existing", entityRef: "K0002" },
    });

    await vi.waitFor(() => {
      expect(releaseDecision).toEqual(expect.any(Function));
    });

    const revisePending = reviseCodexStructureRelation({
      proposalId: "rel-1",
      patch: { forwardLabel: "仲間" },
    });
    // Relation revise must wait on the same mutation queue.
    expect(appendRevisionMock).toHaveBeenCalledTimes(1);

    releaseDecision!();
    await expect(bindingPending).resolves.toBeUndefined();
    await expect(revisePending).rejects.toThrow(/already-satisfied/);
    expect(order).toEqual(["auto-decision-start", "auto-decision-end"]);
    expect(appendDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "rel-1",
        revisionId: "rev-rel-1",
        decision: "deferred",
      }),
    );
    // No stale Relation appendRevision after the auto-decision.
    expect(appendRevisionMock).toHaveBeenCalledTimes(1);
    expect(
      useCodexStructureExtractionStore
        .getState()
        .projection?.proposals.find((row) => row.proposalId === "ent-2")
        ?.revisionId,
    ).toBe("rev-e2b");
  });

  it("keeps Entity Binding success when Relation auto-decision fails", async () => {
    seedBindingRematchProjection();
    appendRevisionMock.mockResolvedValueOnce({ revisionId: "rev-e2b" });
    appendDecisionMock.mockRejectedValueOnce(
      new Error("NEX_PROPOSAL_REVISION_MISMATCH"),
    );

    // forceNative resync after auto-decision failure
    resetNarrativeArtifactIndexForTests();
    getRunReviewBundleMock.mockReset();
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-auto",
        projectId: "p1",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-a" },
        status: "completed",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "t",
        startedAt: null,
        completedAt: null,
        version: 0,
      },
      tasks: [],
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-auto",
      projectId: "p1",
      artifacts: [
        {
          artifactId: "art",
          runId: "run-auto",
          taskId: "t1",
          attemptId: "a1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "ps-1",
            evidenceByProposalId: {
              "ent-1": [
                {
                  anchorId: "a1",
                  quote: "ライカ",
                  documentRef: "D1",
                  method: "exact",
                },
              ],
              "ent-2": [
                {
                  anchorId: "a2",
                  quote: "ベルカ",
                  documentRef: "D1",
                  method: "exact",
                },
              ],
              "rel-1": [
                {
                  anchorId: "a3",
                  quote: "友人",
                  documentRef: "D1",
                  method: "exact",
                },
              ],
            },
            relationLabelsByProposalId: {
              "rel-1": { subjectLabel: "ライカ", objectLabel: "ベルカ" },
            },
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "t",
        },
      ],
      proposalSet: {
        proposalSetId: "ps-1",
        runId: "run-auto",
        projectId: "p1",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
          proposalCount: 3,
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
          existingRelations: [],
          relationDependencies: {
            "rel-1": [
              { kind: "requires-resolution", proposalId: "ent-1" },
              { kind: "requires-resolution", proposalId: "ent-2" },
            ],
          },
        },
        createdAt: "t",
        updatedAt: "t",
        version: 0,
      },
      proposals: [
        {
          proposalId: "ent-1",
          proposalSetId: "ps-1",
          proposalKey: "ne-1",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "approved",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: bindExistingCodexEntityProposal(
              {
                narrativeEntityId: "ne-1",
                canonicalName: "ライカ",
                aliases: [],
                coarseClass: "person",
                typeResolution: { status: "resolved", typeRef: "T0001" },
                binding: {
                  kind: "bind-existing",
                  entityRef: "K0001",
                  enrichment: {
                    aliasesToAdd: [],
                    summary: { kind: "leave" },
                  },
                },
              },
              { proposalId: "ent-1" },
            ).payload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-e1",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: null,
        },
        {
          proposalId: "ent-2",
          proposalSetId: "ps-1",
          proposalKey: "ne-2",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: bindExistingCodexEntityProposal(
              {
                narrativeEntityId: "ne-2",
                canonicalName: "ベルカ",
                aliases: [],
                coarseClass: "person",
                typeResolution: { status: "resolved", typeRef: "T0001" },
                binding: {
                  kind: "bind-existing",
                  entityRef: "K0002",
                  enrichment: {
                    aliasesToAdd: [],
                    summary: { kind: "leave" },
                  },
                },
              },
              { proposalId: "ent-2" },
            ).payload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-e2b",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: null,
        },
        {
          proposalId: "rel-1",
          proposalSetId: "ps-1",
          proposalKey: "rel-key",
          kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: createCodexRelationProposalFromHypothesis({
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
            })!.payload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-rel-1",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: null,
        },
      ],
    });

    await expect(
      resolveCodexStructureBinding({
        proposalId: "ent-2",
        resolution: { kind: "bind-existing", entityRef: "K0002" },
      }),
    ).resolves.toBeUndefined();

    const entity = useCodexStructureExtractionStore
      .getState()
      .projection?.proposals.find((row) => row.proposalId === "ent-2");
    expect(entity?.revisionId).toBe("rev-e2b");
    expect(entity?.proposal.payload.binding.kind).toBe("bind-existing");
  });
});

describe("applyCodexStructureExtractionReview opaque refs", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    prepareApplyMock.mockReset();
    prepareApplyMock.mockResolvedValue({
      prepared: {},
      applied: { created: [{ entityId: "e1" }] },
      status: {},
      commitMap: { entityBindings: {} },
    });
  });

  function setSingleApprovedEntityProjection(
    runId = "run-request-id",
    proposalSetId = "ps-request-id",
  ) {
    const proposal = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-1",
        canonicalName: "ライカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "ライカ", aliases: [], summary: null },
        },
      },
      { proposalId: "prop-retry" },
    );
    useCodexStructureExtractionStore.getState().setProjection({
      runId,
      projectId: "p1",
      workspacePath: "/w",
      openRevision: 1,
      proposalSetId,
      status: "completed",
      coverage: {},
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
      proposals: [
        {
          proposalId: "prop-retry",
          revisionId: "rev-retry",
          proposalKey: "ne-1",
          status: "approved",
          applicability: "applicable",
          displayTitle: "ライカ",
          proposal,
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカ",
              documentRef: "D1",
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
          compiledOperation: {
            kind: "codex.entry.create",
            payload: {
              entryId: "entry-retry",
              typeSlug: "character",
              name: "ライカ",
              summary: null,
              aliases: [],
              parentId: null,
              content: '{"type":"doc","content":[]}',
              narrativeEntityId: "ne-1",
            },
          },
        },
      ],
      relationProposals: [],
      baseDetailProposals: [],
      phaseProposals: [],
      entityCount: 1,
      relationCount: 0,
      baseDetailCount: 0,
      phaseCount: 0,
      unresolvedCount: 0,
      approvedCount: 1,
      catalog: {
        entities: [],
        types: [
          {
            ref: "T0001",
            sourceKey: "character",
            slug: "character",
            label: "character",
          },
        ],
      },
    });
  }

  it("reuses the same requestId when retrying Apply after failure", async () => {
    setSingleApprovedEntityProjection();
    prepareApplyMock.mockRejectedValueOnce(new Error("IPC timeout"));

    await expect(
      applyCodexStructureExtractionReview({ projectId: "p1", entries: [] }),
    ).rejects.toThrow("IPC timeout");

    prepareApplyMock.mockResolvedValueOnce({
      prepared: {},
      applied: { created: [{ entityId: "e1" }] },
      status: {},
      commitMap: { entityBindings: {} },
    });

    await applyCodexStructureExtractionReview({ projectId: "p1", entries: [] });

    const firstRequestId = prepareApplyMock.mock.calls[0]?.[0]?.requestId;
    const secondRequestId = prepareApplyMock.mock.calls[1]?.[0]?.requestId;
    expect(firstRequestId).toBeTruthy();
    expect(secondRequestId).toBe(firstRequestId);
  });

  it("issues a new requestId after successful Apply clears the plan cache", async () => {
    setSingleApprovedEntityProjection();
    await applyCodexStructureExtractionReview({ projectId: "p1", entries: [] });

    const firstRequestId = prepareApplyMock.mock.calls[0]?.[0]?.requestId;
    expect(firstRequestId).toBeTruthy();

    setSingleApprovedEntityProjection();
    await applyCodexStructureExtractionReview({ projectId: "p1", entries: [] });

    const secondRequestId = prepareApplyMock.mock.calls[1]?.[0]?.requestId;
    expect(secondRequestId).toBeTruthy();
    expect(secondRequestId).not.toBe(firstRequestId);
  });

  it("skips already-applied proposals and only commits pending approved rows", async () => {
    const applied = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-applied",
        canonicalName: "ライカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "ライカ", aliases: [], summary: null },
        },
      },
      { proposalId: "prop-applied" },
    );
    const pending = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-pending",
        canonicalName: "ベルカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "ベルカ", aliases: [], summary: null },
        },
      },
      { proposalId: "prop-pending" },
    );

    useCodexStructureExtractionStore.getState().setProjection({
      runId: "run-partial-apply",
      projectId: "p1",
      workspacePath: "/w",
      openRevision: 1,
      proposalSetId: "ps-1",
      status: "completed",
      coverage: {},
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
      proposals: [
        {
          proposalId: "prop-applied",
          revisionId: "rev-a",
          proposalKey: "ne-applied",
          status: "approved",
          applicability: "applicable",
          displayTitle: "ライカ",
          proposal: applied,
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカ",
              documentRef: "D1",
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
          compiledOperation: {
            kind: "codex.entry.create",
            payload: {
              entryId: "entry-applied",
              typeSlug: "character",
              name: "ライカ",
              summary: null,
              aliases: [],
              parentId: null,
              content: '{"type":"doc","content":[]}',
              narrativeEntityId: "ne-applied",
            },
          },
          application: {
            revisionId: "rev-a",
            appliedEntityKind: "codex_entry",
            appliedEntityId: "entry-applied",
          },
        },
        {
          proposalId: "prop-pending",
          revisionId: "rev-b",
          proposalKey: "ne-pending",
          status: "approved",
          applicability: "applicable",
          displayTitle: "ベルカ",
          proposal: pending,
          evidence: [
            {
              anchorId: "a2",
              quote: "ベルカ",
              documentRef: "D1",
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
          compiledOperation: {
            kind: "codex.entry.create",
            payload: {
              entryId: "entry-pending",
              typeSlug: "character",
              name: "ベルカ",
              summary: null,
              aliases: [],
              parentId: null,
              content: '{"type":"doc","content":[]}',
              narrativeEntityId: "ne-pending",
            },
          },
        },
      ],
      relationProposals: [],
      baseDetailProposals: [],
      phaseProposals: [],
      entityCount: 2,
      relationCount: 0,
      baseDetailCount: 0,
      phaseCount: 0,
      unresolvedCount: 0,
      approvedCount: 1,
      catalog: {
        entities: [],
        types: [
          {
            ref: "T0001",
            sourceKey: "character",
            slug: "character",
            label: "character",
          },
        ],
      },
    });

    const count = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: [],
    });

    expect(count).toBe(1);
    expect(prepareApplyMock).toHaveBeenCalledTimes(1);
    const ops = prepareApplyMock.mock.calls[0]?.[0]?.operations;
    expect(ops).toHaveLength(1);
    expect(ops[0]?.proposalId).toBe("prop-pending");
  });

  it("wires applied create-new Entity as existingBindings for follow-up Relation Apply", async () => {
    const applied = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-a",
        canonicalName: "ライカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "ライカ", aliases: [], summary: null },
        },
      },
      { proposalId: "prop-a" },
    );
    const pending = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-b",
        canonicalName: "ベルカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "ベルカ", aliases: [], summary: null },
        },
      },
      { proposalId: "prop-b" },
    );
    const relationProposal = {
      proposalId: "prop-rel",
      kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
      target: { kind: "new" as const, logicalRef: "rel-1" },
      payload: {
        subjectEntityId: "ne-a",
        objectEntityId: "ne-b",
        relation: {
          relationType: "friend_of",
          directionality: "symmetric" as const,
          forwardLabel: "友人",
          inverseLabel: "友人",
        },
        validity: "current" as const,
      },
      dependencies: [
        { kind: "requires-resolution" as const, proposalId: "prop-a" },
        { kind: "requires-resolution" as const, proposalId: "prop-b" },
      ],
    };

    useCodexStructureExtractionStore.getState().setProjection({
      runId: "run-follow-rel",
      projectId: "p1",
      workspacePath: "/w",
      openRevision: 1,
      proposalSetId: "ps-1",
      status: "completed",
      coverage: {},
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
      proposals: [
        {
          proposalId: "prop-a",
          revisionId: "rev-a",
          proposalKey: "ne-a",
          status: "approved",
          applicability: "applicable",
          displayTitle: "ライカ",
          proposal: applied,
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカ",
              documentRef: "D1",
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
          application: {
            revisionId: "rev-a",
            appliedEntityKind: "codex_entry",
            appliedEntityId: "entry-a",
          },
        },
        {
          proposalId: "prop-b",
          revisionId: "rev-b",
          proposalKey: "ne-b",
          status: "approved",
          applicability: "applicable",
          displayTitle: "ベルカ",
          proposal: pending,
          evidence: [
            {
              anchorId: "a2",
              quote: "ベルカ",
              documentRef: "D1",
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
          compiledOperation: {
            kind: "codex.entry.create",
            payload: {
              entryId: "entry-b",
              typeSlug: "character",
              name: "ベルカ",
              summary: null,
              aliases: [],
              parentId: null,
              content: '{"type":"doc","content":[]}',
              narrativeEntityId: "ne-b",
            },
          },
        },
      ],
      relationProposals: [
        {
          proposalId: "prop-rel",
          revisionId: "rev-rel",
          proposalKey: "rel-1",
          status: "approved",
          applicability: "applicable",
          displayTitle: "ライカ → 友人 → ベルカ",
          proposal: relationProposal,
          evidence: [
            {
              anchorId: "a3",
              quote: "友人",
              documentRef: "D1",
              method: "exact",
            },
          ],
          subjectLabel: "ライカ",
          objectLabel: "ベルカ",
          compiledOperation: {
            kind: "codex.relation.create",
            payload: {
              relationId: "rel-fixed",
              fromCodexId: "entry-a",
              toCodexId: "entry-b",
              subjectEntityId: "ne-a",
              objectEntityId: "ne-b",
              relationType: "friend_of",
              directionality: "symmetric",
              forwardLabel: "友人",
              inverseLabel: "友人",
            },
          },
        },
      ],
      entityCount: 2,
      relationCount: 1,
      baseDetailProposals: [],
      phaseProposals: [],
      baseDetailCount: 0,
      phaseCount: 0,
      unresolvedCount: 0,
      approvedCount: 2,
      catalog: {
        entities: [],
        types: [
          {
            ref: "T0001",
            sourceKey: "character",
            slug: "character",
            label: "character",
          },
        ],
      },
    });

    const count = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: [],
    });

    expect(count).toBe(2);
    const input = prepareApplyMock.mock.calls[0]?.[0];
    expect(
      input?.operations.map((op: { proposalId: string }) => op.proposalId),
    ).toEqual(["prop-b", "prop-rel"]);
    expect(input?.existingBindings).toEqual([
      {
        narrativeEntityId: "ne-a",
        codexEntryId: "entry-a",
        source: "existing",
      },
    ]);
  });

  it("resolves K/T via catalog and emits bind-existing when patch is empty", async () => {
    const proposal = bindExistingCodexEntityProposal(
      {
        narrativeEntityId: "ne-1",
        canonicalName: "ライカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "bind-existing",
          entityRef: "K0001",
          enrichment: {
            aliasesToAdd: [],
            summary: { kind: "leave" },
          },
        },
      },
      { proposalId: "p1" },
    );
    useCodexStructureExtractionStore.getState().setProjection({
      runId: "run-1",
      projectId: "p1",
      workspacePath: "/w",
      openRevision: 1,
      proposalSetId: "ps-1",
      status: "completed",
      coverage: {},
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
      proposals: [
        {
          proposalId: "p1",
          revisionId: "rev-1",
          proposalKey: "k1",
          status: "approved",
          applicability: "applicable",
          displayTitle: "ライカ",
          proposal,
          evidence: [
            {
              anchorId: "a1",
              quote: "ライカ",
              documentRef: "D1",
              method: "exact",
            },
          ],
          safety: buildCodexEntityProposalSafetyFlags({
            bindingKind: "bind-existing",
            typeStatus: "resolved",
            evidenceMethods: ["exact"],
            hasExistingCandidates: true,
            hasProperNameMention: true,
            aliasesAllExplicit: true,
          }),
        },
      ],
      relationProposals: [],
      baseDetailProposals: [],
      phaseProposals: [],
      entityCount: 1,
      relationCount: 0,
      baseDetailCount: 0,
      phaseCount: 0,
      unresolvedCount: 0,
      approvedCount: 1,
      catalog: {
        entities: [
          {
            ref: "K0001",
            sourceKey: "entry-real",
            name: "ライカ",
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
    });

    const count = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: [
        { id: "entry-real", version: 2, aliases: "[]", type: "character" },
      ],
    });

    expect(count).toBe(1);
    expect(prepareApplyMock).toHaveBeenCalled();
    const input = prepareApplyMock.mock.calls[0]?.[0];
    expect(input.operations[0]?.operation.kind).toBe(
      "codex.entity.bind-existing",
    );
    expect(input.operations[0]?.operation.payload.entryId).toBe("entry-real");
  });
});

describe("applyCodexStructureExtractionReview: 古くなった結び付けの除外（Q4(a)）", () => {
  const CATALOG = {
    entities: [
      {
        ref: "K0003",
        sourceKey: "entry-riku",
        name: "リク",
        typeRef: "T0001",
        expectedVersion: 1,
        aliases: [] as string[],
      },
      {
        ref: "K0005",
        sourceKey: "entry-sora",
        name: "ソラ",
        typeRef: "T0001",
        expectedVersion: 1,
        aliases: [] as string[],
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
  };
  const evidence = [
    {
      anchorId: "a1",
      quote: "リク",
      documentRef: "D1",
      method: "exact" as const,
    },
  ];

  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    prepareApplyMock.mockReset();
    prepareApplyMock.mockResolvedValue({
      prepared: {},
      applied: {},
      status: {},
      commitMap: { entityBindings: {} },
    });
    appendHumanDecisionMock.mockReset();
    appendHumanDecisionMock.mockResolvedValue({});
    reviseAndDecideAsHumanMock.mockReset();
    reviseAndDecideAsHumanMock.mockResolvedValue({
      proposalId: "b1",
      revisionId: "rev-b1-2",
      revisionNumber: 2,
      decisionId: "d2",
      decision: "approved",
      status: "approved",
    });
  });

  function approvedBind(
    proposalId: string,
    name: string,
    entityRef: string,
    narrativeEntityId: string,
    options: {
      baseVersion: number;
      bulk?: boolean;
      kind?: "codex.entity.bind-existing" | "codex.entry.patch";
    },
  ) {
    const entryId = entityRef === "K0003" ? "entry-riku" : "entry-sora";
    return {
      proposalId,
      revisionId: `rev-${proposalId}`,
      proposalKey: `key-${proposalId}`,
      status: "approved" as const,
      applicability: "applicable" as const,
      displayTitle: name,
      proposal: bindExistingCodexEntityProposal(
        {
          narrativeEntityId,
          canonicalName: name,
          aliases: [],
          coarseClass: "person",
          typeResolution: { status: "resolved", typeRef: "T0001" },
          binding: {
            kind: "bind-existing",
            entityRef,
            enrichment: { aliasesToAdd: [], summary: { kind: "leave" } },
          },
        },
        { proposalId },
      ),
      evidence,
      safety: buildCodexEntityProposalSafetyFlags({
        bindingKind: "bind-existing",
        typeStatus: "resolved",
        evidenceMethods: ["exact"],
        hasExistingCandidates: true,
        hasProperNameMention: true,
        aliasesAllExplicit: true,
      }),
      compiledOperation: {
        kind: options.kind ?? "codex.entity.bind-existing",
        payload: {
          entryId,
          narrativeEntityId,
          baseVersion: options.baseVersion,
        },
      },
      bulkApprovedExactBind: options.bulk ?? false,
    };
  }

  function approvedCreate(proposalId: string, name: string) {
    return {
      proposalId,
      revisionId: `rev-${proposalId}`,
      proposalKey: `key-${proposalId}`,
      status: "approved" as const,
      applicability: "applicable" as const,
      displayTitle: name,
      proposal: createNewBindCodexEntityProposal(
        {
          narrativeEntityId: `ne-${proposalId}`,
          canonicalName: name,
          aliases: [],
          coarseClass: "person",
          typeResolution: { status: "resolved", typeRef: "T0001" },
          binding: {
            kind: "create-new",
            entry: { name, aliases: [], summary: null },
          },
        },
        { proposalId },
      ),
      evidence,
      safety: buildCodexEntityProposalSafetyFlags({
        bindingKind: "create-new",
        typeStatus: "resolved",
        evidenceMethods: ["exact"],
        hasExistingCandidates: false,
        hasProperNameMention: true,
        aliasesAllExplicit: true,
      }),
      compiledOperation: {
        kind: "codex.entry.create",
        payload: {
          entryId: `entry-${proposalId}`,
          typeSlug: "character",
          name,
          summary: null,
          aliases: [],
          parentId: null,
          content: '{"type":"doc","content":[]}',
          narrativeEntityId: `ne-${proposalId}`,
        },
      },
    };
  }

  function publish(proposals: unknown[], extra: Record<string, unknown> = {}) {
    useCodexStructureExtractionStore.getState().setProjection({
      runId: "run-stale",
      projectId: "p1",
      workspacePath: "/w",
      openRevision: 1,
      proposalSetId: "ps-stale",
      status: "completed",
      coverage: {},
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
      proposals: proposals as never,
      relationProposals: [],
      baseDetailProposals: [],
      phaseProposals: [],
      entityCount: proposals.length,
      relationCount: 0,
      baseDetailCount: 0,
      phaseCount: 0,
      unresolvedCount: 0,
      approvedCount: proposals.length,
      catalog: CATALOG,
      ...extra,
    });
  }

  const stored = (id: string) =>
    useCodexStructureExtractionStore
      .getState()
      .projection?.proposals.find((row) => row.proposalId === id);

  const LIVE = (version: number) => [
    {
      id: "entry-riku",
      name: "リク",
      aliases: null,
      type: "character",
      version,
    },
    {
      id: "entry-sora",
      name: "ソラ",
      aliases: null,
      type: "character",
      version: 1,
    },
  ];

  it("結び先が編集されて版が古くなった結び付けを Apply から外して報告し、承認前（保留）へ戻す。新規作成は通す", async () => {
    publish([
      approvedBind("b1", "リク", "K0003", "ne-b1", {
        baseVersion: 1,
        bulk: true,
      }),
      approvedCreate("c1", "ミナ"),
    ]);
    const excludedReport = vi.fn();
    const applied = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: LIVE(7),
      onEntityApprovalsExcluded: excludedReport,
    });
    expect(applied).toBe(1);
    expect(excludedReport).toHaveBeenCalledWith([
      { proposalId: "b1", displayTitle: "リク", reason: "stale-version" },
    ]);
    const committed = prepareApplyMock.mock.calls[0]?.[0]?.operations ?? [];
    expect(
      committed.map((item: { proposalId: string }) => item.proposalId),
    ).toEqual(["c1"]);
    // Native にも deferred（reason = stale-bind）で残し、復元しても approved に戻らない。
    expect(appendHumanDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "b1",
        revisionId: "rev-b1",
        decision: "deferred",
        decisionJson: { reason: "stale-bind", cause: "stale-version" },
      }),
    );
    expect(stored("b1")).toMatchObject({
      status: "deferred",
      staleBind: true,
      bulkApprovedExactBind: false,
      compiledOperation: null,
    });
  });

  it("全部が外れたら commit を呼ばず 0 件を返す", async () => {
    publish([approvedBind("b1", "リク", "K0003", "ne-b1", { baseVersion: 1 })]);
    const applied = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: LIVE(2),
    });
    expect(applied).toBe(0);
    expect(prepareApplyMock).not.toHaveBeenCalled();
  });

  it("結び先が今の Codex に無ければ同じ除外にする（今の一覧が空のときは読めていない可能性があるので除外しない）", async () => {
    publish([approvedBind("b1", "ソラ", "K0005", "ne-b1", { baseVersion: 1 })]);
    const report = vi.fn();
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: [LIVE(1)[0]!],
      onEntityApprovalsExcluded: report,
    });
    expect(report).toHaveBeenCalledWith([
      { proposalId: "b1", displayTitle: "ソラ", reason: "target-missing" },
    ]);

    publish([approvedBind("b1", "ソラ", "K0005", "ne-b1", { baseVersion: 1 })]);
    prepareApplyMock.mockClear();
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: [],
    });
    expect(prepareApplyMock).toHaveBeenCalledTimes(1);
  });

  it("古い patch も同じ述語で外す", async () => {
    publish([
      approvedBind("b1", "リク", "K0003", "ne-b1", {
        baseVersion: 1,
        kind: "codex.entry.patch",
      }),
    ]);
    const report = vi.fn();
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: LIVE(3),
      onEntityApprovalsExcluded: report,
    });
    expect(report).toHaveBeenCalledWith([
      { proposalId: "b1", displayTitle: "リク", reason: "stale-version" },
    ]);
  });

  it("版が合っていれば外さない", async () => {
    publish([approvedBind("b1", "リク", "K0003", "ne-b1", { baseVersion: 7 })]);
    const report = vi.fn();
    const applied = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: LIVE(7),
      onEntityApprovalsExcluded: report,
    });
    expect(applied).toBe(1);
    expect(report).not.toHaveBeenCalled();
    expect(appendHumanDecisionMock).not.toHaveBeenCalled();
  });

  it("外した実体を端点に持つ承認済みの関係は、今回の commit に入れない", async () => {
    const relation = {
      proposalId: "r1",
      revisionId: "rev-r1",
      proposalKey: "rel-key",
      status: "approved" as const,
      applicability: "applicable" as const,
      displayTitle: "友人",
      subjectLabel: "リク",
      objectLabel: "ミナ",
      evidence,
      proposal: {
        proposalId: "r1",
        kind: "codex.relation.create",
        target: { kind: "new", logicalRef: "rel-key" },
        payload: {
          subjectEntityId: "ne-b1",
          objectEntityId: "ne-c1",
          relation: {
            relationType: "friend_of",
            directionality: "symmetric",
            forwardLabel: "友人",
            inverseLabel: "友人",
          },
          validity: "current",
        },
        dependencies: [],
      },
      compiledOperation: {
        kind: "codex.relation.create",
        payload: { relationId: "rel-1" },
      },
    };
    publish(
      [
        approvedBind("b1", "リク", "K0003", "ne-b1", { baseVersion: 1 }),
        approvedCreate("c1", "ミナ"),
      ],
      { relationProposals: [relation], relationCount: 1 },
    );
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: LIVE(9),
    });
    const committed = prepareApplyMock.mock.calls[0]?.[0]?.operations ?? [];
    expect(
      committed.map((item: { proposalId: string }) => item.proposalId),
    ).toEqual(["c1"]);
  });

  it("一括で通した後に依存する関係が付いた結び付けは、版が合っていても外す。手で承認した結び付けは外さない", async () => {
    const relation = {
      proposalId: "r1",
      revisionId: "rev-r1",
      proposalKey: "rel-key",
      status: "unreviewed" as const,
      applicability: "blocked" as const,
      displayTitle: "友人",
      subjectLabel: "リク",
      objectLabel: "ソラ",
      evidence,
      proposal: {
        proposalId: "r1",
        kind: "codex.relation.create",
        target: { kind: "new", logicalRef: "rel-key" },
        payload: {
          subjectEntityId: "ne-b1",
          objectEntityId: "ne-b2",
          relation: {
            relationType: "friend_of",
            directionality: "symmetric",
            forwardLabel: "友人",
            inverseLabel: "友人",
          },
          validity: "current",
        },
        dependencies: [],
      },
    };
    publish(
      [
        approvedBind("b1", "リク", "K0003", "ne-b1", {
          baseVersion: 7,
          bulk: true,
        }),
        approvedBind("b2", "ソラ", "K0005", "ne-b2", { baseVersion: 1 }),
      ],
      { relationProposals: [relation], relationCount: 1 },
    );
    const report = vi.fn();
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: LIVE(7),
      onEntityApprovalsExcluded: report,
    });
    expect(report).toHaveBeenCalledWith([
      { proposalId: "b1", displayTitle: "リク", reason: "dependent-added" },
    ]);
  });

  it("名前つきの今の Codex で完全一致でなくなっていた一括の結び付けは、版が合っていても外す", async () => {
    publish([
      approvedBind("b1", "リク", "K0003", "ne-b1", {
        baseVersion: 7,
        bulk: true,
      }),
    ]);
    const report = vi.fn();
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: [
        ...LIVE(7),
        {
          id: "entry-new",
          name: "リク",
          aliases: null,
          type: "character",
          version: 1,
        },
      ],
      onEntityApprovalsExcluded: report,
    });
    expect(report).toHaveBeenCalledWith([
      { proposalId: "b1", displayTitle: "リク", reason: "no-longer-exact" },
    ]);
  });

  it("除外 → 今の版で承認し直し → Apply に入る（承認し直しは今の Codex の版で op を固定する）", async () => {
    publish([
      approvedBind("b1", "リク", "K0003", "ne-b1", {
        baseVersion: 1,
        bulk: true,
      }),
    ]);
    await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: LIVE(7),
    });
    expect(prepareApplyMock).not.toHaveBeenCalled();
    expect(stored("b1")?.status).toBe("deferred");

    await decideCodexStructureProposal({
      proposalId: "b1",
      status: "approved",
      entries: LIVE(7),
    });
    expect(stored("b1")).toMatchObject({
      status: "approved",
      staleBind: false,
      bulkApprovedExactBind: false,
    });
    expect(stored("b1")?.compiledOperation?.payload.baseVersion).toBe(7);

    const report = vi.fn();
    const applied = await applyCodexStructureExtractionReview({
      projectId: "p1",
      entries: LIVE(7),
      onEntityApprovalsExcluded: report,
    });
    expect(applied).toBe(1);
    expect(report).not.toHaveBeenCalled();
    expect(
      prepareApplyMock.mock.calls[0]?.[0]?.operations[0]?.operation,
    ).toMatchObject({
      kind: "codex.entity.bind-existing",
      payload: { baseVersion: 7 },
    });
  });
});
