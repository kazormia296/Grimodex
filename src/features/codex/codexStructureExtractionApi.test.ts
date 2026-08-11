import { beforeEach, describe, expect, it, vi } from "vitest";

const createRunMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const cancelRunMock = vi.hoisted(() => vi.fn());
const saveProposalSetMock = vi.hoisted(() => vi.fn());
const appendDecisionMock = vi.hoisted(() => vi.fn());
const appendRevisionMock = vi.hoisted(() => vi.fn());
const reviseAndDecideMock = vi.hoisted(() => vi.fn());
const prepareApplyMock = vi.hoisted(() => vi.fn());
const claimTaskMock = vi.hoisted(() => vi.fn());
const finishTaskMock = vi.hoisted(() => vi.fn());
const failTaskMock = vi.hoisted(() => vi.fn());
const buildSnapshotMock = vi.hoisted(() => vi.fn());
const runPrepassMock = vi.hoisted(() => vi.fn());
const getRunReviewBundleMock = vi.hoisted(() => vi.fn());

vi.mock("@/application/narrative-extraction/runRepository", () => ({
  createRun: createRunMock,
  getRun: getRunMock,
  cancelRun: cancelRunMock,
}));
vi.mock("@/application/narrative-extraction/proposalRepository", () => ({
  saveProposalSet: saveProposalSetMock,
  appendDecision: appendDecisionMock,
  appendRevision: appendRevisionMock,
  reviseAndDecide: reviseAndDecideMock,
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

import { resetNarrativeArtifactIndexForTests } from "@/application/narrative-extraction/artifactRepository";
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
    resetCodexStructureExtractionStoreForTests();
    createRunMock.mockReset();
    getRunMock.mockReset();
    cancelRunMock.mockReset();
    saveProposalSetMock.mockReset();
    claimTaskMock.mockReset();
    finishTaskMock.mockReset();
    failTaskMock.mockReset();
    prepareApplyMock.mockReset();
    appendDecisionMock.mockReset();
    appendRevisionMock.mockReset();
    reviseAndDecideMock.mockReset();
    buildSnapshotMock.mockReset();
    runPrepassMock.mockReset();
    buildSnapshotMock.mockResolvedValue({
      ok: false,
      diagnostics: [{ code: "SNAPSHOT_SKIPPED_IN_TEST" }],
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

    expect(createRunMock).toHaveBeenCalled();
    expect(saveProposalSetMock).toHaveBeenCalled();
    expect(projection.runId).toBe("native-run-1");
    expect(projection.proposalSetId).toBe("native-ps-1");
    expect(projection.proposals[0]?.revisionId).toBe("native-rev-1");
    expect(projection.baseDetailProposals[0]?.revisionId).toBe("native-rev-2");
    expect(projection.phaseProposals[0]?.revisionId).toBe("native-rev-3");
    const savedPayload = saveProposalSetMock.mock.calls[0]?.[0] as {
      proposals: readonly { kind: string }[];
    };
    expect(savedPayload.proposals.map((proposal) => proposal.kind)).toEqual([
      CODEX_ENTITY_BIND_PROPOSAL_KIND,
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
    ).toHaveLength(1);
    expect(
      finishPayload.artifacts[0]?.payloadJson?.phaseProposals,
    ).toHaveLength(1);
    expect(projection.catalog?.types[0]?.slug).toBe("character");
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
  });
});

describe("bulkApproveSafeCodexStructureProposals", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    appendDecisionMock.mockReset();
    appendRevisionMock.mockReset();
    reviseAndDecideMock.mockReset();
    reviseAndDecideMock.mockResolvedValue({
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
    expect(reviseAndDecideMock).toHaveBeenCalledWith(
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
});

describe("reviseCodexStructureProposal concurrency", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    appendRevisionMock.mockReset();
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
  });

  it("serializes decide and revise on the same proposal queue", async () => {
    seedEditableEntity();
    const order: string[] = [];
    let releaseDecision: (() => void) | undefined;
    appendDecisionMock.mockImplementationOnce(
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
