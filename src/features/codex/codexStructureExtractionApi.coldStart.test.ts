import { beforeEach, describe, expect, it, vi } from "vitest";

const getRunReviewBundleMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const listResumableRunsMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@/application/narrative-extraction/nativeApi",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/nativeApi")
      >();
    return {
      ...actual,
      narrativeExtractionGetRunReviewBundle: getRunReviewBundleMock,
      narrativeExtractionGetRun: getRunMock,
    };
  },
);

vi.mock("@/application/narrative-extraction/runRepository", () => ({
  getRun: (...args: unknown[]) => getRunMock(...args),
  listResumableRuns: listResumableRunsMock,
}));

import { resetNarrativeArtifactIndexForTests } from "@/application/narrative-extraction/artifactRepository";
import {
  CODEX_ENTITY_BIND_PROPOSAL_KIND,
  createNewBindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import {
  CODEX_RELATION_CREATE_PROPOSAL_KIND,
  type CreateCodexRelationProposal,
} from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import {
  CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
  CODEX_STRUCTURE_PROPOSAL_SET_KIND,
  CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
  getCodexStructureExtractionReview,
  resetCodexStructureExtractionApiCachesForTests,
  restoreCodexStructureExtractionReview,
} from "./codexStructureExtractionApi";
import {
  buildCodexEntityProposalSafetyFlags,
  resetCodexStructureExtractionStoreForTests,
} from "./codexStructureExtractionStore";

function sampleEntityProposal(proposalId = "prop-entity-1") {
  return createNewBindCodexEntityProposal(
    {
      narrativeEntityId: "ne-1",
      canonicalName: "ライカ",
      aliases: [],
      coarseClass: "person",
      typeResolution: { status: "resolved", typeRef: "T0001" },
      binding: {
        kind: "create-new",
        entry: {
          name: "ライカ",
          aliases: [],
          summary: null,
        },
      },
    },
    { proposalId },
  );
}

function sampleRelationProposal(
  proposalId = "prop-rel-1",
  deps: readonly string[] = ["prop-entity-1"],
): CreateCodexRelationProposal {
  return {
    proposalId,
    kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
    target: { kind: "new", logicalRef: "rel-1" },
    payload: {
      subjectEntityId: "ne-1",
      objectEntityId: "ne-2",
      relation: {
        relationType: "friend_of",
        directionality: "symmetric",
        forwardLabel: "友人",
        inverseLabel: "友人",
      },
      validity: "current",
    },
    dependencies: deps.map((id) => ({
      kind: "requires-resolution" as const,
      proposalId: id,
    })),
  };
}

describe("getCodexStructureExtractionReview cold-start restore", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    getRunReviewBundleMock.mockReset();
    getRunMock.mockReset();
    listResumableRunsMock.mockReset();
  });

  it("hydrates Map from Native bundle and restores proposals with evidence + deps", async () => {
    const entity = sampleEntityProposal("prop-entity-cold");
    const relation = sampleRelationProposal("prop-rel-cold", [
      "prop-entity-cold",
    ]);
    const evidence = [
      {
        anchorId: "a1",
        quote: "ライカは友人だ",
        documentRef: "doc:scene-1",
        method: "exact" as const,
      },
    ];
    const safety = buildCodexEntityProposalSafetyFlags({
      bindingKind: "create-new",
      typeStatus: "resolved",
      evidenceMethods: ["exact"],
      hasExistingCandidates: false,
      hasProperNameMention: true,
      aliasesAllExplicit: true,
    });

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-cold-1",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold", sceneIds: ["s1"] },
        specJson: {},
        specDigest: "spec",
        snapshotDigest: null,
        catalogDigest: null,
        registryDigest: null,
        status: "completed",
        coverageJson: {
          mode: "complete",
          documentCount: 1,
          windowCount: 1,
          completedWindows: 1,
          gaps: [],
        },
        outcomeSummaryJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        version: 1,
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
      runId: "run-cold-1",
      projectId: "project-cold",
      artifacts: [
        {
          artifactId: "art-review",
          runId: "run-cold-1",
          taskId: "task-1",
          attemptId: "attempt-1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "set-cold-1",
            entities: [
              {
                proposalId: "prop-entity-cold",
                proposalKey: "ne-1",
                proposal: entity,
                evidence,
                safety,
                applicability: "applicable",
                displayTitle: "ライカ",
                hypothesisId: "ne-1",
              },
            ],
            relations: [
              {
                proposalId: "prop-rel-cold",
                proposalKey: "rel-ne-1-ne-2",
                proposal: {
                  ...relation,
                  dependencies: [],
                },
                evidence,
                subjectLabel: "ライカ",
                objectLabel: "ベルカ",
                applicability: "applicable",
                displayTitle: "友人",
                hypothesisId: "hyp-rel-1",
              },
            ],
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "2026-01-01T00:00:30.000Z",
        },
      ],
      proposalSet: {
        proposalSetId: "set-cold-1",
        runId: "run-cold-1",
        projectId: "project-cold",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
          proposalCount: 2,
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
          relationDependencies: {
            "prop-rel-cold": [
              {
                kind: "requires-resolution",
                proposalId: "prop-entity-cold",
              },
            ],
          },
        },
        createdAt: "2026-01-01T00:00:40.000Z",
        updatedAt: "2026-01-01T00:00:40.000Z",
        version: 0,
      },
      proposals: [
        {
          proposalId: "prop-entity-cold",
          proposalSetId: "set-cold-1",
          proposalKey: "ne-1",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "approved",
          payloadJson: {
            entryId: "entry-locked-1",
            typeSlug: "character",
            name: "ライカ",
            summary: null,
            aliases: [],
            parentId: null,
            content: '{"type":"doc","content":[]}',
            narrativeEntityId: "ne-1",
          },
          currentRevisionId: "rev-entity-native",
          createdAt: "2026-01-01T00:00:40.000Z",
          updatedAt: "2026-01-01T00:00:50.000Z",
          latestDecision: {
            decisionId: "dec-1",
            proposalId: "prop-entity-cold",
            revisionId: "rev-entity-native",
            decision: "approved",
            decisionJson: {},
            createdAt: "2026-01-01T00:00:50.000Z",
            createdBy: "reviewer",
          },
        },
        {
          proposalId: "prop-rel-cold",
          proposalSetId: "set-cold-1",
          proposalKey: "rel-ne-1-ne-2",
          kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: relation.payload as unknown as Record<string, unknown>,
          currentRevisionId: "rev-rel-native",
          createdAt: "2026-01-01T00:00:40.000Z",
          updatedAt: "2026-01-01T00:00:40.000Z",
          latestDecision: null,
        },
      ],
    });

    const restored = await getCodexStructureExtractionReview("run-cold-1", {
      projectId: "project-cold",
      workspacePath: "/ws/cold",
      openRevision: 3,
    });

    expect(getRunReviewBundleMock).toHaveBeenCalledWith({
      runId: "run-cold-1",
      projectId: "project-cold",
    });
    expect(restored.proposalSetId).toBe("set-cold-1");
    expect(restored.folderId).toBe("folder-cold");
    expect(restored.proposals).toHaveLength(1);
    expect(restored.relationProposals).toHaveLength(1);

    const [entityRow] = restored.proposals;
    expect(entityRow.proposalId).toBe("prop-entity-cold");
    expect(entityRow.revisionId).toBe("rev-entity-native");
    expect(entityRow.status).toBe("approved");
    expect(entityRow.evidence[0]?.quote).toBe("ライカは友人だ");
    expect(entityRow.proposal.payload.canonicalName).toBe("ライカ");
    expect(entityRow.compiledOperation?.kind).toBe("codex.entry.create");
    expect(entityRow.compiledOperation?.payload.entryId).toBe("entry-locked-1");

    const [relRow] = restored.relationProposals;
    expect(relRow.proposalId).toBe("prop-rel-cold");
    expect(relRow.revisionId).toBe("rev-rel-native");
    expect(relRow.subjectLabel).toBe("ライカ");
    expect(relRow.proposal.dependencies).toEqual([
      { kind: "requires-resolution", proposalId: "prop-entity-cold" },
    ]);
  });

  it("fails closed when Native proposal set is missing", async () => {
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-cold-empty",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: {},
        specJson: {},
        specDigest: "spec",
        snapshotDigest: null,
        catalogDigest: null,
        registryDigest: null,
        status: "completed",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        version: 0,
      },
      tasks: [],
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    });
    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-cold-empty",
      projectId: "project-cold",
      artifacts: [],
      proposalSet: null,
      proposals: [],
    });

    await expect(
      getCodexStructureExtractionReview("run-cold-empty", {
        projectId: "project-cold",
        workspacePath: "/ws",
        openRevision: 1,
      }),
    ).rejects.toThrow(/no Native proposal set/);
  });
});

describe("restoreCodexStructureExtractionReview candidate fallback", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    getRunReviewBundleMock.mockReset();
    getRunMock.mockReset();
    listResumableRunsMock.mockReset();
  });

  it("skips a newer running run without ProposalSet and restores the older review", async () => {
    listResumableRunsMock.mockResolvedValue([
      {
        run: {
          runId: "run-crash",
          projectId: "project-cold",
          surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
          status: "running",
        },
      },
      {
        run: {
          runId: "run-old-review",
          projectId: "project-cold",
          surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
          status: "completed",
        },
      },
    ]);

    getRunMock.mockImplementation(async (runId: string) => ({
      run: {
        runId,
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-old" },
        specJson: {},
        specDigest: "spec",
        snapshotDigest: null,
        catalogDigest: null,
        registryDigest: null,
        status: runId === "run-crash" ? "running" : "completed",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        version: 0,
      },
      tasks: [],
      taskCounts: {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    }));

    getRunReviewBundleMock.mockImplementation(
      async (args: { runId: string }) => {
        if (args.runId === "run-crash") {
          return {
            runId: "run-crash",
            projectId: "project-cold",
            artifacts: [],
            proposalSet: null,
            proposals: [],
          };
        }
        const entity = sampleEntityProposal("prop-old");
        return {
          runId: "run-old-review",
          projectId: "project-cold",
          artifacts: [
            {
              artifactId: "art-old",
              runId: "run-old-review",
              taskId: "t1",
              attemptId: "a1",
              artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
              payloadStorage: "inline-json",
              payloadJson: {
                proposalSetId: "set-old",
                entities: [
                  {
                    proposalId: "prop-old",
                    proposalKey: "ne-1",
                    proposal: entity,
                    evidence: [
                      {
                        anchorId: "a1",
                        quote: "old quote",
                        documentRef: "doc:1",
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
                    applicability: "applicable",
                    displayTitle: "Older entity",
                  },
                ],
                relations: [],
              },
              payloadRef: null,
              payloadDigest: null,
              createdAt: "2026-01-01T00:00:30.000Z",
            },
          ],
          proposalSet: {
            proposalSetId: "set-old",
            runId: "run-old-review",
            projectId: "project-cold",
            setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
            status: "draft",
            summaryJson: {
              catalog: { entities: [], types: [] },
              relationDependencies: {},
            },
            createdAt: "2026-01-01T00:00:40.000Z",
            updatedAt: "2026-01-01T00:00:40.000Z",
            version: 0,
          },
          proposals: [
            {
              proposalId: "prop-old",
              proposalSetId: "set-old",
              proposalKey: "ne-1",
              kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
              status: "approved",
              payloadJson: entity.payload as unknown as Record<string, unknown>,
              currentRevisionId: "rev-old",
              createdAt: "2026-01-01T00:00:40.000Z",
              updatedAt: "2026-01-01T00:00:50.000Z",
              latestDecision: null,
            },
          ],
        };
      },
    );

    const restored = await restoreCodexStructureExtractionReview({
      projectId: "project-cold",
      workspacePath: "/ws/cold",
      openRevision: 3,
    });

    expect(restored?.runId).toBe("run-old-review");
    expect(restored?.proposals[0]?.displayTitle).toBe("Older entity");
    expect(restored?.folderId).toBe("folder-old");
  });
});
