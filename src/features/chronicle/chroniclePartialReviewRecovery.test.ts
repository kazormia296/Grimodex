import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumableRunSummary } from "@/application/narrative-extraction/nativeApi";
import {
  abandonChroniclePartialReview,
  restoreChronicleExtractionReview,
} from "./extractEventsApi";
import {
  buildProposalSafetyFlags,
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
  type ChronicleExtractionReviewProjection,
  type ChronicleReviewProposal,
} from "./chronicleExtractionStore";

const appendHumanDecisionMock = vi.hoisted(() => vi.fn());
const nativeListResumableRunsMock = vi.hoisted(() => vi.fn());
const nativeIsRunResumableForReviewMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@/application/narrative-extraction/proposalRepository",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/proposalRepository")
      >();
    return { ...actual, appendHumanDecision: appendHumanDecisionMock };
  },
);

vi.mock(
  "@/application/narrative-extraction/nativeApi",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/nativeApi")
      >();
    return {
      ...actual,
      narrativeExtractionListResumableRuns: nativeListResumableRunsMock,
      narrativeExtractionIsRunResumableForReview:
        nativeIsRunResumableForReviewMock,
    };
  },
);

const RUN_ID = "run-historical-partial";
const PROJECT_ID = "project-partial";

function proposal(
  proposalId: string,
  overrides: Partial<ChronicleReviewProposal> = {},
): ChronicleReviewProposal {
  const revisionId = `revision:${proposalId}`;
  return {
    proposalId,
    revisionId,
    proposalKey: `key:${proposalId}`,
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: proposalId,
    payload: {
      eventId: `event:${proposalId}`,
      title: proposalId,
      note: null,
      actuality: "actual",
      significance: "scene-level",
      evidenceAnchorIds: [`anchor:${proposalId}`],
      evidenceDocumentRefs: [`document:${proposalId}`],
      disclosure: {
        secret: false,
        revealDocumentRef: `document:${proposalId}`,
      },
      unresolvedMetadata: {
        participantSurfaces: [],
        locationSurface: null,
        temporalExpressions: [],
      },
    },
    plannedTitle: proposalId,
    plannedMatch: { status: "none" },
    match: { status: "none" },
    evidence: [],
    safety: buildProposalSafetyFlags({
      match: { status: "none" },
      actuality: "actual",
      evidenceMethods: ["exact"],
    }),
    probableDuplicateChoice: null,
    ...overrides,
    application: overrides.application ?? null,
  };
}

function partialProjection(
  remainder: ChronicleReviewProposal,
): ChronicleExtractionReviewProjection {
  const applied = proposal("proposal-applied", { status: "approved" });
  return {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    workspacePath: "/workspace-partial",
    openRevision: 4,
    proposalSetId: "proposal-set-partial",
    status: "completed",
    coverage: {
      mode: "complete",
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
    proposals: [
      {
        ...applied,
        application: {
          commitId: "commit-applied",
          revisionId: applied.revisionId ?? "",
          appliedEntityKind: "chronicle-event",
          appliedEntityId: "event-applied",
          createdAt: "2026-08-26T00:00:00.000Z",
          applicationKind: "normal",
          compensatesApplicationId: null,
        },
      },
      remainder,
    ],
  };
}

function resumableSummary(runId = RUN_ID): ResumableRunSummary {
  return {
    runId,
    projectId: PROJECT_ID,
    surfacePathId: "chronicle.extract",
    status: "completed",
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-26T00:00:00.000Z",
    startedAt: "2026-08-26T00:00:01.000Z",
    completedAt: "2026-08-26T00:01:00.000Z",
  };
}

describe("historical partial Chronicle review recovery", () => {
  beforeEach(() => {
    resetChronicleExtractionStoreForTests();
    appendHumanDecisionMock.mockReset();
    nativeListResumableRunsMock.mockReset();
    nativeIsRunResumableForReviewMock.mockReset();
  });

  it("durably rejects the unapplied remainder, proves exact absence, and cannot resurrect on restore", async () => {
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    let exactRunResumable = true;
    appendHumanDecisionMock.mockImplementation(async () => {
      await decisionGate;
      exactRunResumable = false;
      return {};
    });
    nativeIsRunResumableForReviewMock.mockImplementation(async () => {
      expect(useChronicleExtractionStore.getState().projection?.runId).toBe(
        RUN_ID,
      );
      return {
        runId: RUN_ID,
        projectId: PROJECT_ID,
        surfacePathId: "chronicle.extract",
        resumable: exactRunResumable,
      };
    });
    nativeListResumableRunsMock.mockResolvedValue([]);
    useChronicleExtractionStore
      .getState()
      .setProjection(partialProjection(proposal("proposal-unapplied")));

    const pending = abandonChroniclePartialReview({
      runId: RUN_ID,
      projectId: PROJECT_ID,
    });
    expect(useChronicleExtractionStore.getState().applyMutationInFlight).toBe(
      true,
    );
    expect(
      useChronicleExtractionStore.getState().tryBeginReviewMutation(),
    ).toBe(false);

    releaseDecision();
    await expect(pending).resolves.toEqual({
      runId: RUN_ID,
      terminalizedProposalCount: 1,
    });
    expect(appendHumanDecisionMock).toHaveBeenCalledTimes(1);
    expect(appendHumanDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        projectId: PROJECT_ID,
        proposalId: "proposal-unapplied",
        revisionId: "revision:proposal-unapplied",
        decision: "rejected",
        decisionJson: {
          reason: "historical-partial-review-abandoned",
        },
      }),
    );
    expect(
      appendHumanDecisionMock.mock.calls.some(
        ([payload]) => payload.proposalId === "proposal-applied",
      ),
    ).toBe(false);
    expect(nativeIsRunResumableForReviewMock).toHaveBeenCalledWith({
      runId: RUN_ID,
      projectId: PROJECT_ID,
      surfacePathId: "chronicle.extract",
    });
    expect(useChronicleExtractionStore.getState().projection).toBeNull();
    expect(useChronicleExtractionStore.getState().applyMutationInFlight).toBe(
      false,
    );

    await expect(
      restoreChronicleExtractionReview({
        projectId: PROJECT_ID,
        workspacePath: "/workspace-partial",
        openRevision: 4,
      }),
    ).resolves.toBeNull();
    expect(nativeIsRunResumableForReviewMock).toHaveBeenCalledTimes(1);
    expect(nativeListResumableRunsMock).toHaveBeenCalledTimes(1);
  });

  it("uses exact resumability with 101 newer candidates and retains projection while the target Run remains", async () => {
    appendHumanDecisionMock.mockResolvedValue({});
    const durableResumableRuns = [
      ...Array.from({ length: 101 }, (_, index) =>
        resumableSummary(`run-newer-${index.toString().padStart(3, "0")}`),
      ),
      resumableSummary(),
    ];
    nativeListResumableRunsMock.mockResolvedValue(
      durableResumableRuns.slice(0, 100),
    );
    nativeIsRunResumableForReviewMock.mockResolvedValue({
      runId: RUN_ID,
      projectId: PROJECT_ID,
      surfacePathId: "chronicle.extract",
      resumable: durableResumableRuns.some((run) => run.runId === RUN_ID),
    });
    useChronicleExtractionStore.getState().setProjection(
      partialProjection(
        proposal("proposal-duplicate", {
          match: {
            status: "probable-duplicate",
            candidates: ["event-existing"],
            reasons: ["same-title"],
          },
        }),
      ),
    );

    await expect(
      abandonChroniclePartialReview({
        runId: RUN_ID,
        projectId: PROJECT_ID,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_PARTIAL_REVIEW_STILL_RESUMABLE");
    expect(appendHumanDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "proposal-duplicate",
        decision: "rejected",
        decisionJson: { probableDuplicateChoice: "skip-as-same" },
      }),
    );
    expect(useChronicleExtractionStore.getState().projection).not.toBeNull();
    expect(useChronicleExtractionStore.getState().applyMutationInFlight).toBe(
      false,
    );
    expect(nativeIsRunResumableForReviewMock).toHaveBeenCalledTimes(1);
    expect(nativeListResumableRunsMock).not.toHaveBeenCalled();
  });

  it("fails closed when the exact resumability result omits a boolean verdict", async () => {
    appendHumanDecisionMock.mockResolvedValue({});
    nativeIsRunResumableForReviewMock.mockResolvedValue({
      runId: RUN_ID,
      projectId: PROJECT_ID,
      surfacePathId: "chronicle.extract",
      resumable: null,
    });
    useChronicleExtractionStore
      .getState()
      .setProjection(partialProjection(proposal("proposal-unapplied")));

    await expect(
      abandonChroniclePartialReview({
        runId: RUN_ID,
        projectId: PROJECT_ID,
      }),
    ).rejects.toThrow("NEX_CHRONICLE_PARTIAL_REVIEW_RESUMABILITY_MISMATCH");
    expect(appendHumanDecisionMock).toHaveBeenCalledTimes(1);
    expect(useChronicleExtractionStore.getState().projection?.runId).toBe(
      RUN_ID,
    );
    expect(useChronicleExtractionStore.getState().applyMutationInFlight).toBe(
      false,
    );
    expect(nativeListResumableRunsMock).not.toHaveBeenCalled();
  });
});
