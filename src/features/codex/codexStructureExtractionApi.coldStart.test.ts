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
  CODEX_BASE_DETAIL_SET_PROPOSAL_KIND,
  createSetCodexBaseDetailProposal,
} from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";
import {
  CODEX_PHASE_BIND_PROPOSAL_KIND,
  createNewBindCodexPhaseProposal,
} from "@/features/narrative-extraction/proposals/bindCodexPhaseProposal";
import { buildCodexReviewRevisionEnvelope } from "./extraction/reviewRevisionEnvelope";
import {
  applyCodexStructureExtractionReview,
  CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
  CODEX_STRUCTURE_PROPOSAL_SET_KIND,
  CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
  getCodexStructureExtractionReview,
  resetCodexStructureExtractionApiCachesForTests,
  restoreCodexStructureExtractionReview,
} from "./codexStructureExtractionApi";
import {
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
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

  it("hydrates from Native envelopes + evidence artifact without publishing store", async () => {
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
            evidenceByProposalId: {
              "prop-entity-cold": evidence,
              "prop-rel-cold": evidence,
            },
            relationLabelsByProposalId: {
              "prop-rel-cold": {
                subjectLabel: "ライカ",
                objectLabel: "ベルカ",
              },
            },
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
          existingRelations: [],
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
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: entity.payload,
            compiledOperation: {
              kind: "codex.entry.create",
              payload: {
                entryId: "entry-locked-1",
                typeSlug: "character",
                name: "ライカ",
                summary: null,
                aliases: [],
                parentId: null,
                content: '{"type":"doc","content":[]}',
                narrativeEntityId: "ne-1",
              },
            },
          }) as unknown as Record<string, unknown>,
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
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: relation.payload,
          }) as unknown as Record<string, unknown>,
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
      folderId: "folder-cold",
    });

    expect(useCodexStructureExtractionStore.getState().projection).toBeNull();
    expect(restored.proposalSetId).toBe("set-cold-1");
    expect(restored.folderId).toBe("folder-cold");
    expect(restored.proposals[0]?.compiledOperation?.kind).toBe(
      "codex.entry.create",
    );
    expect(restored.proposals[0]?.evidence[0]?.quote).toBe("ライカは友人だ");
    expect(restored.relationProposals[0]?.proposal.dependencies).toEqual([
      { kind: "requires-resolution", proposalId: "prop-entity-cold" },
    ]);
    expect(restored.baseDetailProposals).toEqual([]);
    expect(restored.phaseProposals).toEqual([]);
    expect(restored.baseDetailCount).toBe(0);
    expect(restored.phaseCount).toBe(0);
  });

  it("restores Phase/Base Detail metadata with Native status, revision, and payload authority", async () => {
    const baseProposal = createSetCodexBaseDetailProposal({
      narrativeEntityId: "ne-state",
      definitionRef: "D0001",
      facetKey: "role.current",
      value: { kind: "text", text: "artifact-stale" },
      temporalEligibility: "timeless",
      createId: () => "prop-base-cold",
    });
    expect(baseProposal).not.toBeNull();
    const phaseProposal = createNewBindCodexPhaseProposal(
      {
        narrativeEntityId: "ne-state",
        anchorDocumentRef: "S000001",
        labelSuggestion: "artifact-stale-phase",
        binding: {
          kind: "create-new",
          phase: {
            label: "Artifact phase",
            anchorDocumentRef: "S000001",
          },
        },
        detailOverrides: [],
      },
      { proposalId: "prop-phase-cold", logicalRef: "phase:cold" },
    );
    const baseMetadata = {
      proposalId: "prop-base-cold",
      revisionId: "artifact-base-rev",
      proposalKey: "base-proj-1",
      status: "unreviewed" as const,
      applicability: "applicable" as const,
      displayTitle: "State · role.current",
      proposal: baseProposal!,
      evidence: [
        {
          anchorId: "base-anchor",
          quote: "base evidence",
          documentRef: "B000001",
          method: "exact" as const,
        },
      ],
      safety: {
        timeless: true,
        emptyExisting: true,
        lossless: true,
        bound: true,
        notClear: true,
        notSummarized: true,
      },
      entityLabel: "State",
      facetKey: "role.current",
      existingValue: null,
    };
    const phaseMetadata = {
      proposalId: "prop-phase-cold",
      revisionId: "artifact-phase-rev",
      proposalKey: "boundary-1",
      status: "unreviewed" as const,
      applicability: "applicable" as const,
      displayTitle: "Artifact phase",
      proposal: phaseProposal,
      evidence: [
        {
          anchorId: "phase-anchor",
          quote: "phase evidence",
          documentRef: "S000001",
          method: "exact" as const,
        },
      ],
      safety: {
        noSummaryOverride: true,
        noConflict: true,
        bound: true,
        notClear: true,
        notSummarized: true,
        notExistingPhaseAppend: true,
      },
      entityLabel: "State",
      persistence: {
        kind: "proposal" as const,
        reason: "major-durable" as const,
      },
      valueDeltas: [],
      existingPhaseCandidates: [],
      boundaryId: "boundary-1",
    };

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-phase-detail-cold",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold" },
        status: "completed",
        coverageJson: {},
        outcomeSummaryJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
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
      runId: "run-phase-detail-cold",
      projectId: "project-cold",
      artifacts: [
        {
          artifactId: "art-phase-detail-review",
          runId: "run-phase-detail-cold",
          taskId: "task-1",
          attemptId: "attempt-1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "set-phase-detail-cold",
            evidenceByProposalId: {},
            relationLabelsByProposalId: {},
            baseDetailProposals: [baseMetadata],
            phaseProposals: [phaseMetadata],
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "2026-01-01T00:00:30.000Z",
        },
      ],
      proposalSet: {
        proposalSetId: "set-phase-detail-cold",
        runId: "run-phase-detail-cold",
        projectId: "project-cold",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
          proposalCount: 2,
          catalog: { entities: [], types: [] },
          existingRelations: [],
          relationDependencies: {},
        },
        createdAt: "2026-01-01T00:00:40.000Z",
        updatedAt: "2026-01-01T00:00:40.000Z",
        version: 0,
      },
      proposals: [
        {
          proposalId: "prop-base-cold",
          proposalSetId: "set-phase-detail-cold",
          proposalKey: "base-proj-1",
          kind: CODEX_BASE_DETAIL_SET_PROPOSAL_KIND,
          status: "approved",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: {
              ...baseProposal!.payload,
              value: { kind: "text", text: "native-base" },
            },
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "native-base-rev",
          createdAt: "2026-01-01T00:00:40.000Z",
          updatedAt: "2026-01-01T00:00:50.000Z",
          latestDecision: null,
          application: {
            commitId: "commit-base-cold",
            revisionId: "native-base-rev",
            appliedEntityKind: "codex_detail_value",
            appliedEntityId: "detail-base-cold",
            createdAt: "2026-01-01T00:00:55.000Z",
          },
        },
        {
          proposalId: "prop-phase-cold",
          proposalSetId: "set-phase-detail-cold",
          proposalKey: "boundary-1",
          kind: CODEX_PHASE_BIND_PROPOSAL_KIND,
          status: "approved",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: {
              ...phaseProposal.payload,
              labelSuggestion: "native-phase",
            },
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "native-phase-rev",
          createdAt: "2026-01-01T00:00:40.000Z",
          updatedAt: "2026-01-01T00:00:50.000Z",
          latestDecision: null,
          application: {
            commitId: "commit-phase-cold",
            revisionId: "native-phase-rev",
            appliedEntityKind: "codex_entry_phase",
            appliedEntityId: "phase-cold",
            createdAt: "2026-01-01T00:00:55.000Z",
          },
        },
      ],
    });

    const restored = await getCodexStructureExtractionReview(
      "run-phase-detail-cold",
      {
        projectId: "project-cold",
        workspacePath: "/ws/cold",
        openRevision: 3,
        folderId: "folder-cold",
      },
    );

    expect(restored.proposals).toEqual([]);
    expect(restored.relationProposals).toEqual([]);
    expect(restored.baseDetailCount).toBe(1);
    expect(restored.phaseCount).toBe(1);
    expect(restored.approvedCount).toBe(0);
    expect(restored.baseDetailProposals[0]).toMatchObject({
      revisionId: "native-base-rev",
      status: "approved",
      displayTitle: "State · role.current",
      evidence: [{ quote: "base evidence" }],
      proposal: { payload: { value: { kind: "text", text: "native-base" } } },
      application: {
        revisionId: "native-base-rev",
        appliedEntityKind: "codex_detail_value",
        appliedEntityId: "detail-base-cold",
      },
    });
    expect(restored.phaseProposals[0]).toMatchObject({
      revisionId: "native-phase-rev",
      status: "approved",
      displayTitle: "Artifact phase",
      evidence: [{ quote: "phase evidence" }],
      proposal: { payload: { labelSuggestion: "native-phase" } },
      application: {
        revisionId: "native-phase-rev",
        appliedEntityKind: "codex_entry_phase",
        appliedEntityId: "phase-cold",
      },
    });

    useCodexStructureExtractionStore.getState().setProjection(restored);
    await expect(
      applyCodexStructureExtractionReview({
        projectId: "project-cold",
        entries: [],
      }),
    ).resolves.toBe(0);
  });

  it("attaches Native application and excludes applied rows from approvedCount", async () => {
    const entityA = sampleEntityProposal("prop-entity-a");
    const entityB = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-2",
        canonicalName: "ベルカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "ベルカ", aliases: [], summary: null },
        },
      },
      { proposalId: "prop-entity-b" },
    );
    const evidence = [
      {
        anchorId: "a1",
        quote: "quote",
        documentRef: "doc:1",
        method: "exact" as const,
      },
    ];

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-partial",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold" },
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
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
    });

    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-partial",
      projectId: "project-cold",
      artifacts: [
        {
          artifactId: "art",
          runId: "run-partial",
          taskId: "t1",
          attemptId: "a1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "set-partial",
            evidenceByProposalId: {
              "prop-entity-a": evidence,
              "prop-entity-b": evidence,
            },
            relationLabelsByProposalId: {},
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "2026-01-01T00:00:30.000Z",
        },
      ],
      proposalSet: {
        proposalSetId: "set-partial",
        runId: "run-partial",
        projectId: "project-cold",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
          catalog: { entities: [], types: [] },
          existingRelations: [],
          relationDependencies: {},
        },
        createdAt: "2026-01-01T00:00:40.000Z",
        updatedAt: "2026-01-01T00:00:40.000Z",
        version: 0,
      },
      proposals: [
        {
          proposalId: "prop-entity-a",
          proposalSetId: "set-partial",
          proposalKey: "ne-1",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "approved",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: entityA.payload,
            compiledOperation: {
              kind: "codex.entry.create",
              payload: {
                entryId: "entry-a",
                typeSlug: "character",
                name: "ライカ",
                summary: null,
                aliases: [],
                parentId: null,
                content: '{"type":"doc","content":[]}',
                narrativeEntityId: "ne-1",
              },
            },
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-a",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: {
            decisionId: "d-a",
            proposalId: "prop-entity-a",
            revisionId: "rev-a",
            decision: "approved",
            decisionJson: {},
            createdAt: "t",
            createdBy: "r",
          },
          application: {
            commitId: "commit-1",
            revisionId: "rev-a",
            appliedEntityKind: "codex_entry",
            appliedEntityId: "entry-a",
            createdAt: "t",
          },
        },
        {
          proposalId: "prop-entity-b",
          proposalSetId: "set-partial",
          proposalKey: "ne-2",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "approved",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: entityB.payload,
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
                narrativeEntityId: "ne-2",
              },
            },
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-b",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: {
            decisionId: "d-b",
            proposalId: "prop-entity-b",
            revisionId: "rev-b",
            decision: "approved",
            decisionJson: {},
            createdAt: "t",
            createdBy: "r",
          },
          application: null,
        },
      ],
    });

    const restored = await getCodexStructureExtractionReview("run-partial", {
      projectId: "project-cold",
      workspacePath: "/ws",
      openRevision: 1,
      folderId: "folder-cold",
    });

    expect(restored.proposals[0]?.application?.appliedEntityId).toBe("entry-a");
    expect(restored.proposals[1]?.application).toBeNull();
    expect(restored.approvedCount).toBe(1);
  });

  it("ignores already-satisfied decisions bound to a prior revision", async () => {
    const entity = sampleEntityProposal("prop-entity-cold");
    const relation = sampleRelationProposal("prop-rel-edited", [
      "prop-entity-cold",
    ]);
    const swappedPayload = {
      ...relation.payload,
      subjectEntityId: "ne-2",
      objectEntityId: "ne-1",
    };
    const evidence = [
      {
        anchorId: "a1",
        quote: "quote",
        documentRef: "doc:1",
        method: "exact" as const,
      },
    ];

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-stale-decision",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold" },
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
      runId: "run-stale-decision",
      projectId: "project-cold",
      artifacts: [
        {
          artifactId: "art",
          runId: "run-stale-decision",
          taskId: "t1",
          attemptId: "a1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "set-stale",
            evidenceByProposalId: {
              "prop-entity-cold": evidence,
              "prop-rel-edited": evidence,
            },
            relationLabelsByProposalId: {
              "prop-rel-edited": {
                subjectLabel: "ライカ",
                objectLabel: "ベルカ",
              },
            },
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "t",
        },
      ],
      proposalSet: {
        proposalSetId: "set-stale",
        runId: "run-stale-decision",
        projectId: "project-cold",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
          catalog: { entities: [], types: [] },
          existingRelations: [],
          relationDependencies: {
            "prop-rel-edited": [
              { kind: "requires-resolution", proposalId: "prop-entity-cold" },
            ],
          },
        },
        createdAt: "t",
        updatedAt: "t",
        version: 0,
      },
      proposals: [
        {
          proposalId: "prop-entity-cold",
          proposalSetId: "set-stale",
          proposalKey: "ne-1",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "approved",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: entity.payload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-entity",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: {
            decisionId: "d1",
            proposalId: "prop-entity-cold",
            revisionId: "rev-entity",
            decision: "approved",
            decisionJson: {},
            createdAt: "t",
            createdBy: "r",
          },
          application: null,
        },
        {
          proposalId: "prop-rel-edited",
          proposalSetId: "set-stale",
          proposalKey: "rel-edited",
          kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: swappedPayload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-rel-2",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: {
            decisionId: "d-old",
            proposalId: "prop-rel-edited",
            revisionId: "rev-rel-1",
            decision: "deferred",
            decisionJson: {
              reason: "already-satisfied",
              existingRelationRef: "rel-old",
            },
            createdAt: "t",
            createdBy: "r",
          },
          application: null,
        },
      ],
    });

    const restored = await getCodexStructureExtractionReview(
      "run-stale-decision",
      {
        projectId: "project-cold",
        workspacePath: "/ws",
        openRevision: 1,
        folderId: "folder-cold",
      },
    );

    expect(restored.relationProposals[0]?.applicability).not.toBe(
      "already-satisfied",
    );
  });

  it("prefers entityTitles over artifact labels after endpoint swap", async () => {
    const entityA = sampleEntityProposal("prop-entity-a");
    const entityB = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-2",
        canonicalName: "ベルカ",
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "create-new",
          entry: { name: "ベルカ", aliases: [], summary: null },
        },
      },
      { proposalId: "prop-entity-b" },
    );
    const relation = sampleRelationProposal("prop-rel-swap", [
      "prop-entity-a",
      "prop-entity-b",
    ]);
    const swappedPayload = {
      ...relation.payload,
      subjectEntityId: "ne-2",
      objectEntityId: "ne-1",
    };
    const evidence = [
      {
        anchorId: "a1",
        quote: "quote",
        documentRef: "doc:1",
        method: "exact" as const,
      },
    ];

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-swap",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold" },
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
      runId: "run-swap",
      projectId: "project-cold",
      artifacts: [
        {
          artifactId: "art",
          runId: "run-swap",
          taskId: "t1",
          attemptId: "a1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "set-swap",
            evidenceByProposalId: {
              "prop-entity-a": evidence,
              "prop-entity-b": evidence,
              "prop-rel-swap": evidence,
            },
            relationLabelsByProposalId: {
              "prop-rel-swap": {
                subjectLabel: "ライカ",
                objectLabel: "ベルカ",
              },
            },
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "t",
        },
      ],
      proposalSet: {
        proposalSetId: "set-swap",
        runId: "run-swap",
        projectId: "project-cold",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
          catalog: { entities: [], types: [] },
          existingRelations: [],
          relationDependencies: {
            "prop-rel-swap": [
              { kind: "requires-resolution", proposalId: "prop-entity-a" },
              { kind: "requires-resolution", proposalId: "prop-entity-b" },
            ],
          },
        },
        createdAt: "t",
        updatedAt: "t",
        version: 0,
      },
      proposals: [
        {
          proposalId: "prop-entity-a",
          proposalSetId: "set-swap",
          proposalKey: "ne-1",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: entityA.payload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-a",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: null,
          application: null,
        },
        {
          proposalId: "prop-entity-b",
          proposalSetId: "set-swap",
          proposalKey: "ne-2",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: entityB.payload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-b",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: null,
          application: null,
        },
        {
          proposalId: "prop-rel-swap",
          proposalSetId: "set-swap",
          proposalKey: "rel-swap",
          kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: swappedPayload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-rel",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: null,
          application: null,
        },
      ],
    });

    const restored = await getCodexStructureExtractionReview("run-swap", {
      projectId: "project-cold",
      workspacePath: "/ws",
      openRevision: 1,
      folderId: "folder-cold",
    });

    const row = restored.relationProposals[0];
    expect(row?.proposal.payload.subjectEntityId).toBe("ne-2");
    expect(row?.proposal.payload.objectEntityId).toBe("ne-1");
    expect(row?.subjectLabel).toBe("ベルカ");
    expect(row?.objectLabel).toBe("ライカ");
    expect(row?.displayTitle).toBe("ベルカ → 友人 → ライカ");
  });

  it("fails closed when review-projection artifact is missing", async () => {
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-no-artifact",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold" },
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
      runId: "run-no-artifact",
      projectId: "project-cold",
      artifacts: [],
      proposalSet: {
        proposalSetId: "set-no-art",
        runId: "run-no-artifact",
        projectId: "project-cold",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
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
          proposalId: "prop-entity-cold",
          proposalSetId: "set-no-art",
          proposalKey: "ne-1",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: sampleEntityProposal().payload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-1",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: null,
          application: null,
        },
      ],
    });

    await expect(
      getCodexStructureExtractionReview("run-no-artifact", {
        projectId: "project-cold",
        workspacePath: "/ws",
        openRevision: 1,
        folderId: "folder-cold",
      }),
    ).rejects.toThrow(/missing review-projection artifact/);
  });

  it("fails closed when application.revisionId != currentRevisionId", async () => {
    const entity = sampleEntityProposal("prop-mismatch-app");
    const evidence = [
      {
        anchorId: "a1",
        quote: "quote",
        documentRef: "doc:1",
        method: "exact" as const,
      },
    ];

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-app-mismatch",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold" },
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
      runId: "run-app-mismatch",
      projectId: "project-cold",
      artifacts: [
        {
          artifactId: "art",
          runId: "run-app-mismatch",
          taskId: "t1",
          attemptId: "a1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "set-mismatch",
            evidenceByProposalId: { "prop-mismatch-app": evidence },
            relationLabelsByProposalId: {},
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "t",
        },
      ],
      proposalSet: {
        proposalSetId: "set-mismatch",
        runId: "run-app-mismatch",
        projectId: "project-cold",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
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
          proposalId: "prop-mismatch-app",
          proposalSetId: "set-mismatch",
          proposalKey: "ne-1",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "approved",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: entity.payload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-new",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: {
            decisionId: "d1",
            proposalId: "prop-mismatch-app",
            revisionId: "rev-new",
            decision: "approved",
            decisionJson: {},
            createdAt: "t",
            createdBy: "r",
          },
          application: {
            commitId: "c1",
            revisionId: "rev-old-applied",
            appliedEntityKind: "codex_entry",
            appliedEntityId: "entry-1",
            createdAt: "t",
          },
        },
      ],
    });

    await expect(
      getCodexStructureExtractionReview("run-app-mismatch", {
        projectId: "project-cold",
        workspacePath: "/ws",
        openRevision: 1,
        folderId: "folder-cold",
      }),
    ).rejects.toThrow(/NEX_APPLICATION_REVISION_MISMATCH/);
  });

  it("re-fetches Native review bundle on second restore (no completed-promise cache)", async () => {
    const entityA = sampleEntityProposal("prop-a");
    const entityB = createNewBindCodexEntityProposal(
      {
        narrativeEntityId: "ne-2",
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
    const evidence = [
      {
        anchorId: "a1",
        quote: "quote",
        documentRef: "doc:1",
        method: "exact" as const,
      },
    ];

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-refetch",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold" },
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

    const baseArtifact = {
      artifactId: "art",
      runId: "run-refetch",
      taskId: "t1",
      attemptId: "a1",
      artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
      payloadStorage: "inline-json" as const,
      payloadJson: {
        proposalSetId: "set-refetch",
        evidenceByProposalId: {
          "prop-a": evidence,
          "prop-b": evidence,
        },
        relationLabelsByProposalId: {},
      },
      payloadRef: null,
      payloadDigest: null,
      createdAt: "t",
    };
    const baseSet = {
      proposalSetId: "set-refetch",
      runId: "run-refetch",
      projectId: "project-cold",
      setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
      status: "draft",
      summaryJson: {
        catalog: { entities: [], types: [] },
        existingRelations: [],
        relationDependencies: {},
      },
      createdAt: "t",
      updatedAt: "t",
      version: 0,
    };

    getRunReviewBundleMock
      .mockResolvedValueOnce({
        runId: "run-refetch",
        projectId: "project-cold",
        artifacts: [baseArtifact],
        proposalSet: baseSet,
        proposals: [
          {
            proposalId: "prop-a",
            proposalSetId: "set-refetch",
            proposalKey: "ne-1",
            kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
            status: "approved",
            payloadJson: buildCodexReviewRevisionEnvelope({
              reviewPayload: entityA.payload,
            }) as unknown as Record<string, unknown>,
            currentRevisionId: "rev-a",
            createdAt: "t",
            updatedAt: "t",
            latestDecision: {
              decisionId: "d-a",
              proposalId: "prop-a",
              revisionId: "rev-a",
              decision: "approved",
              decisionJson: {},
              createdAt: "t",
              createdBy: "r",
            },
            application: {
              commitId: "c1",
              revisionId: "rev-a",
              appliedEntityKind: "codex_entry",
              appliedEntityId: "entry-a",
              createdAt: "t",
            },
          },
          {
            proposalId: "prop-b",
            proposalSetId: "set-refetch",
            proposalKey: "ne-2",
            kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
            status: "unreviewed",
            payloadJson: buildCodexReviewRevisionEnvelope({
              reviewPayload: entityB.payload,
            }) as unknown as Record<string, unknown>,
            currentRevisionId: "rev-b1",
            createdAt: "t",
            updatedAt: "t",
            latestDecision: null,
            application: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        runId: "run-refetch",
        projectId: "project-cold",
        artifacts: [baseArtifact],
        proposalSet: baseSet,
        proposals: [
          {
            proposalId: "prop-a",
            proposalSetId: "set-refetch",
            proposalKey: "ne-1",
            kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
            status: "approved",
            payloadJson: buildCodexReviewRevisionEnvelope({
              reviewPayload: entityA.payload,
            }) as unknown as Record<string, unknown>,
            currentRevisionId: "rev-a",
            createdAt: "t",
            updatedAt: "t",
            latestDecision: {
              decisionId: "d-a",
              proposalId: "prop-a",
              revisionId: "rev-a",
              decision: "approved",
              decisionJson: {},
              createdAt: "t",
              createdBy: "r",
            },
            application: {
              commitId: "c1",
              revisionId: "rev-a",
              appliedEntityKind: "codex_entry",
              appliedEntityId: "entry-a",
              createdAt: "t",
            },
          },
          {
            proposalId: "prop-b",
            proposalSetId: "set-refetch",
            proposalKey: "ne-2",
            kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
            status: "approved",
            payloadJson: buildCodexReviewRevisionEnvelope({
              reviewPayload: entityB.payload,
            }) as unknown as Record<string, unknown>,
            currentRevisionId: "rev-b2",
            createdAt: "t",
            updatedAt: "t",
            latestDecision: {
              decisionId: "d-b",
              proposalId: "prop-b",
              revisionId: "rev-b2",
              decision: "approved",
              decisionJson: {},
              createdAt: "t",
              createdBy: "r",
            },
            application: {
              commitId: "c2",
              revisionId: "rev-b2",
              appliedEntityKind: "codex_entry",
              appliedEntityId: "entry-b",
              createdAt: "t",
            },
          },
        ],
      });

    const scope = {
      projectId: "project-cold",
      workspacePath: "/ws",
      openRevision: 1,
      folderId: "folder-cold",
    };

    const first = await getCodexStructureExtractionReview("run-refetch", scope);
    expect(
      first.proposals.find((p) => p.proposalId === "prop-b")?.application,
    ).toBeNull();
    expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);

    // Simulate Dialog Apply clear — do not reset artifact index between restores.
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();

    const second = await getCodexStructureExtractionReview(
      "run-refetch",
      scope,
    );
    expect(getRunReviewBundleMock).toHaveBeenCalledTimes(2);
    expect(
      second.proposals.find((p) => p.proposalId === "prop-b")?.application
        ?.appliedEntityId,
    ).toBe("entry-b");
    expect(second.approvedCount).toBe(0);
  });

  it("forceNative bypasses warm Store and rebuilds from Native revision", async () => {
    const entity = sampleEntityProposal("prop-force");
    const evidence = [
      {
        anchorId: "a1",
        quote: "ライカ",
        documentRef: "doc:scene-1",
        method: "exact" as const,
      },
    ];
    const stalePayload = {
      ...entity.payload,
      canonicalName: "古い名前",
      binding: {
        kind: "create-new" as const,
        entry: { name: "古い名前", aliases: [] as string[], summary: null },
      },
    };
    const nativePayload = {
      ...entity.payload,
      canonicalName: "灰の目",
      binding: {
        kind: "create-new" as const,
        entry: { name: "灰の目", aliases: [] as string[], summary: null },
      },
    };

    useCodexStructureExtractionStore.getState().setProjection({
      runId: "run-force",
      projectId: "project-cold",
      workspacePath: "/ws",
      openRevision: 1,
      proposalSetId: "set-force",
      folderId: "folder-cold",
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
          proposalId: "prop-force",
          revisionId: "rev-1",
          proposalKey: "ne-1",
          status: "unreviewed",
          applicability: "applicable",
          displayTitle: "古い名前",
          proposal: { ...entity, payload: stalePayload },
          evidence,
          safety: {
            evidenceExact: true,
            typeResolved: true,
            noExistingCandidates: true,
            explicitProperName: true,
            explicitAliasesOnly: true,
            noRelationDeps: true,
            createNew: true,
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
      approvedCount: 0,
      catalog: { entities: [], types: [] },
    });

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-force",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold" },
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
      runId: "run-force",
      projectId: "project-cold",
      artifacts: [
        {
          artifactId: "art-force",
          runId: "run-force",
          taskId: "t1",
          attemptId: "a1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "set-force",
            evidenceByProposalId: { "prop-force": evidence },
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "t",
        },
      ],
      proposalSet: {
        proposalSetId: "set-force",
        runId: "run-force",
        projectId: "project-cold",
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
          proposalId: "prop-force",
          proposalSetId: "set-force",
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

    const warm = await getCodexStructureExtractionReview("run-force", {
      projectId: "project-cold",
      workspacePath: "/ws",
      openRevision: 1,
      folderId: "folder-cold",
    });
    expect(warm.proposals[0]?.revisionId).toBe("rev-1");
    expect(getRunReviewBundleMock).not.toHaveBeenCalled();

    const forced = await getCodexStructureExtractionReview(
      "run-force",
      {
        projectId: "project-cold",
        workspacePath: "/ws",
        openRevision: 1,
        folderId: "folder-cold",
      },
      { forceNative: true },
    );
    expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);
    expect(forced.proposals[0]?.revisionId).toBe("rev-2");
    expect(forced.proposals[0]?.displayTitle).toBe("灰の目");
  });

  it("fails closed when an unapplied proposal lacks Evidence entries", async () => {
    const entity = sampleEntityProposal("prop-no-ev");
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-no-ev",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-cold" },
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
      runId: "run-no-ev",
      projectId: "project-cold",
      artifacts: [
        {
          artifactId: "art",
          runId: "run-no-ev",
          taskId: "t1",
          attemptId: "a1",
          artifactKind: CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "set-no-ev",
            evidenceByProposalId: {},
            relationLabelsByProposalId: {},
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "t",
        },
      ],
      proposalSet: {
        proposalSetId: "set-no-ev",
        runId: "run-no-ev",
        projectId: "project-cold",
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        status: "draft",
        summaryJson: {
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
          proposalId: "prop-no-ev",
          proposalSetId: "set-no-ev",
          proposalKey: "ne-1",
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          status: "unreviewed",
          payloadJson: buildCodexReviewRevisionEnvelope({
            reviewPayload: entity.payload,
          }) as unknown as Record<string, unknown>,
          currentRevisionId: "rev-1",
          createdAt: "t",
          updatedAt: "t",
          latestDecision: null,
          application: null,
        },
      ],
    });

    await expect(
      getCodexStructureExtractionReview("run-no-ev", {
        projectId: "project-cold",
        workspacePath: "/ws",
        openRevision: 1,
        folderId: "folder-cold",
      }),
    ).rejects.toThrow(/missing evidence for proposal prop-no-ev/);
  });

  it("rejects folder mismatch before hydrate", async () => {
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-other-folder",
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: { folderId: "folder-b" },
        status: "completed",
        coverageJson: {},
        taskCounts: {
          queued: 0,
          running: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
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

    await expect(
      getCodexStructureExtractionReview("run-other-folder", {
        projectId: "project-cold",
        workspacePath: "/ws",
        openRevision: 1,
        folderId: "folder-a",
      }),
    ).rejects.toThrow(/folder mismatch/);
    expect(getRunReviewBundleMock).not.toHaveBeenCalled();
  });
});

describe("restoreCodexStructureExtractionReview folder + candidate fallback", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    resetCodexStructureExtractionStoreForTests();
    resetCodexStructureExtractionApiCachesForTests();
    getRunReviewBundleMock.mockReset();
    getRunMock.mockReset();
    listResumableRunsMock.mockReset();
  });

  it("skips other-folder and broken runs, restores matching folder review", async () => {
    listResumableRunsMock.mockResolvedValue([
      {
        run: {
          runId: "run-other-folder",
          projectId: "project-cold",
          surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
          scopeJson: { folderId: "folder-b" },
          status: "completed",
        },
      },
      {
        run: {
          runId: "run-crash",
          projectId: "project-cold",
          surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
          scopeJson: { folderId: "folder-a" },
          status: "running",
        },
      },
      {
        run: {
          runId: "run-old-review",
          projectId: "project-cold",
          surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
          scopeJson: { folderId: "folder-a" },
          status: "completed",
        },
      },
    ]);

    getRunMock.mockImplementation(async (runId: string) => ({
      run: {
        runId,
        projectId: "project-cold",
        surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
        scopeJson: {
          folderId: runId === "run-other-folder" ? "folder-b" : "folder-a",
        },
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
                evidenceByProposalId: {
                  "prop-old": [
                    {
                      anchorId: "a1",
                      quote: "old quote",
                      documentRef: "doc:1",
                      method: "exact",
                    },
                  ],
                },
                relationLabelsByProposalId: {},
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
              existingRelations: [],
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
              payloadJson: buildCodexReviewRevisionEnvelope({
                reviewPayload: entity.payload,
              }) as unknown as Record<string, unknown>,
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
      folderId: "folder-a",
    });

    expect(restored?.runId).toBe("run-old-review");
    expect(restored?.folderId).toBe("folder-a");
    expect(useCodexStructureExtractionStore.getState().projection).toBeNull();
  });
});
