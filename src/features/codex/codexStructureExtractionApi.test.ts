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
    };
  },
);
vi.mock("@/application/narrative-extraction/codexCommitCoordinator", () => ({
  prepareAndApplyCodexCommit: prepareApplyMock,
}));
vi.mock("@/application/narrative-extraction/projectSnapshotAdapter", () => ({
  buildProjectNarrativeSnapshot: buildSnapshotMock,
}));
vi.mock("./extraction/entityCandidatePrepass", () => ({
  runEntityCandidatePrepass: runPrepassMock,
}));

import {
  bindExistingCodexEntityProposal,
  createNewBindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import {
  applyCodexStructureExtractionReview,
  buildCodexStructureCatalogs,
  buildRelationCoMentionQuote,
  bulkApproveSafeCodexStructureProposals,
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

describe("applyCodexStructureExtractionReview opaque refs", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    prepareApplyMock.mockReset();
    prepareApplyMock.mockResolvedValue({
      prepared: {},
      applied: { created: [{ entityId: "e1" }] },
      status: {},
      commitMap: { entityBindings: {} },
    });
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
      entityCount: 1,
      relationCount: 0,
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
