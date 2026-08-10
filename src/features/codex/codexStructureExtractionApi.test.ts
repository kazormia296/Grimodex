import { beforeEach, describe, expect, it, vi } from "vitest";

const createRunMock = vi.hoisted(() => vi.fn());
const saveProposalSetMock = vi.hoisted(() => vi.fn());
const prepareApplyMock = vi.hoisted(() => vi.fn());

vi.mock("@/application/narrative-extraction/runRepository", () => ({
  createRun: createRunMock,
}));
vi.mock("@/application/narrative-extraction/proposalRepository", () => ({
  saveProposalSet: saveProposalSetMock,
  appendDecision: vi.fn(),
  appendRevision: vi.fn(),
}));
vi.mock("@/application/narrative-extraction/codexCommitCoordinator", () => ({
  prepareAndApplyCodexCommit: prepareApplyMock,
}));
vi.mock("@/application/narrative-extraction/projectSnapshotAdapter", () => ({
  buildProjectNarrativeSnapshot: vi.fn(async () => ({
    ok: false,
    diagnostics: [{ code: "SNAPSHOT_SKIPPED_IN_TEST" }],
  })),
}));
vi.mock("./extraction/entityCandidatePrepass", () => ({
  runEntityCandidatePrepass: vi.fn(),
}));

import { bindExistingCodexEntityProposal } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import {
  applyCodexStructureExtractionReview,
  buildCodexStructureCatalogs,
  startCodexStructureExtraction,
} from "./codexStructureExtractionApi";
import {
  buildCodexEntityProposalSafetyFlags,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
} from "./codexStructureExtractionStore";

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

describe("startCodexStructureExtraction product safety", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    createRunMock.mockReset();
    saveProposalSetMock.mockReset();
    prepareApplyMock.mockReset();
    createRunMock.mockResolvedValue({
      runId: "native-run-1",
      status: "completed",
      taskIds: ["t1"],
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
