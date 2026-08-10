import { beforeEach, describe, expect, it, vi } from "vitest";

const getRunReviewBundleMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());

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
  listResumableRuns: vi.fn(),
}));

import { resetNarrativeArtifactIndexForTests } from "@/application/narrative-extraction/artifactRepository";
import { CHRONICLE_EXTRACT_ARTIFACT_KINDS } from "@/application/narrative-extraction/extractionCoordinator";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  getChronicleExtractionReview,
  resetChronicleExtractionApiCachesForTests,
} from "./chronicleExtractionApi";
import { resetChronicleExtractionStoreForTests } from "./chronicleExtractionStore";

function sampleProposal(
  overrides?: Partial<CreateChronicleEventProposalPayloadV1>,
): CreateChronicleEventProposalPayloadV1 {
  return {
    eventId: "ev-cold-1",
    title: "Cold start event",
    note: null,
    actuality: "actual",
    significance: "scene-level",
    evidenceAnchorIds: ["anchor-1"],
    evidenceDocumentRefs: ["doc:scene-1"],
    disclosure: {
      secret: false,
      revealDocumentRef: "doc:scene-1",
    },
    unresolvedMetadata: {
      participantSurfaces: [],
      locationSurface: null,
      temporalExpressions: [],
    },
    ...overrides,
  };
}

describe("getChronicleExtractionReview cold-start restore", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    resetChronicleExtractionStoreForTests();
    resetChronicleExtractionApiCachesForTests();
    getRunReviewBundleMock.mockReset();
    getRunMock.mockReset();
  });

  it("hydrates Map from Native bundle and restores proposals with Native revision ids", async () => {
    const proposal = sampleProposal();
    const nativeRevisionId = "rev-native-abc";
    const nativeProposalId = "prop-native-xyz";

    getRunMock.mockResolvedValue({
      run: {
        runId: "run-cold-1",
        projectId: "project-cold",
        surfacePathId: "chronicle.extract",
        scopeJson: {},
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
          artifactId: "art-proposals",
          runId: "run-cold-1",
          taskId: "task-1",
          attemptId: "attempt-1",
          artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.proposals,
          payloadStorage: "inline-json",
          payloadJson: {
            proposalSetId: "set-cold-1",
            proposals: [proposal],
            planned: [
              {
                proposal,
                match: { status: "none" },
                hypothesisId: "hyp-1",
              },
            ],
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "2026-01-01T00:00:30.000Z",
        },
        {
          artifactId: "art-evidence",
          runId: "run-cold-1",
          taskId: "task-1",
          attemptId: "attempt-1",
          artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.resolvedEvidence,
          payloadStorage: "inline-json",
          payloadJson: {
            anchors: [
              {
                id: "anchor-1",
                documentRef: "doc:scene-1",
                quote: "quoted text",
                method: "exact",
              },
            ],
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "2026-01-01T00:00:20.000Z",
        },
        {
          artifactId: "art-snapshot",
          runId: "run-cold-1",
          taskId: "task-1",
          attemptId: "attempt-1",
          artifactKind: CHRONICLE_EXTRACT_ARTIFACT_KINDS.snapshot,
          payloadStorage: "inline-json",
          payloadJson: {
            snapshot: {
              documents: [
                {
                  ref: "doc:scene-1",
                  origin: { kind: "project-node", nodeId: "scene-1" },
                },
              ],
            },
          },
          payloadRef: null,
          payloadDigest: null,
          createdAt: "2026-01-01T00:00:10.000Z",
        },
      ],
      proposalSet: {
        proposalSetId: "set-cold-1",
        runId: "run-cold-1",
        projectId: "project-cold",
        setKind: "chronicle.extract.review@1",
        status: "draft",
        summaryJson: {},
        createdAt: "2026-01-01T00:00:40.000Z",
        updatedAt: "2026-01-01T00:00:40.000Z",
        version: 0,
      },
      proposals: [
        {
          proposalId: nativeProposalId,
          proposalSetId: "set-cold-1",
          proposalKey: "ev-cold-1:0",
          kind: "chronicle.create-event@1",
          status: "approved",
          payloadJson: proposal,
          currentRevisionId: nativeRevisionId,
          createdAt: "2026-01-01T00:00:40.000Z",
          updatedAt: "2026-01-01T00:00:50.000Z",
          latestDecision: {
            decisionId: "dec-1",
            proposalId: nativeProposalId,
            revisionId: nativeRevisionId,
            decision: "approved",
            decisionJson: { probableDuplicateChoice: "create-as-new" },
            createdAt: "2026-01-01T00:00:50.000Z",
            createdBy: "reviewer",
          },
        },
      ],
    });

    const restored = await getChronicleExtractionReview("run-cold-1", {
      projectId: "project-cold",
      workspacePath: "/ws/cold",
      openRevision: 3,
    });

    expect(getRunReviewBundleMock).toHaveBeenCalledWith({
      runId: "run-cold-1",
      projectId: "project-cold",
    });
    expect(restored.proposalSetId).toBe("set-cold-1");
    expect(restored.proposals).toHaveLength(1);
    const [row] = restored.proposals;
    expect(row.proposalId).toBe(nativeProposalId);
    expect(row.revisionId).toBe(nativeRevisionId);
    expect(row.revisionId).not.toMatch(/^local-rev-/);
    expect(row.proposalId).not.toMatch(/^local-proposal-/);
    expect(row.status).toBe("approved");
    expect(row.displayTitle).toBe("Cold start event");
    expect(row.probableDuplicateChoice).toBe("create-as-new");
    expect(row.evidence[0]?.quote).toBe("quoted text");
  });

  it("fails closed when Native proposal set is missing", async () => {
    getRunMock.mockResolvedValue({
      run: {
        runId: "run-cold-empty",
        projectId: "project-cold",
        surfacePathId: "chronicle.extract",
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
      getChronicleExtractionReview("run-cold-empty", {
        projectId: "project-cold",
        workspacePath: "/ws",
        openRevision: 1,
      }),
    ).rejects.toThrow(/no Native proposal set/);
  });
});
