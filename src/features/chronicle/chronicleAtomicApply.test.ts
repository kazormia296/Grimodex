import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewBundleProposalApplication } from "@/application/narrative-extraction/nativeApi";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  __setCommitCoordinatorForTests,
  applyChronicleExtractionReview,
} from "./extractEventsApi";
import {
  buildProposalSafetyFlags,
  getChronicleApplyReadiness,
  selectChronicleProposalsForAtomicApply,
  type ChronicleReviewProposal,
} from "./chronicleExtractionStore";

const commitMock = vi.fn();

function payload(eventId: string): CreateChronicleEventProposalPayloadV1 {
  return {
    eventId,
    title: eventId,
    note: null,
    actuality: "actual",
    significance: "scene-level",
    evidenceAnchorIds: [`anchor:${eventId}`],
    evidenceDocumentRefs: [`document:${eventId}`],
    disclosure: {
      secret: false,
      revealDocumentRef: `document:${eventId}`,
    },
    unresolvedMetadata: {
      participantSurfaces: [],
      locationSurface: null,
      temporalExpressions: [],
    },
  };
}

function application(revisionId: string): ReviewBundleProposalApplication {
  return {
    commitId: "commit-1",
    revisionId,
    appliedEntityKind: "chronicle-event",
    appliedEntityId: "event-applied",
    createdAt: "2026-08-26T00:00:00.000Z",
    applicationKind: "normal",
    compensatesApplicationId: null,
  };
}

function proposal(
  proposalId: string,
  overrides: Partial<ChronicleReviewProposal> = {},
): ChronicleReviewProposal {
  const body = payload(proposalId);
  return {
    proposalId,
    revisionId: `revision:${proposalId}`,
    proposalKey: `key:${proposalId}`,
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: body.title,
    payload: body,
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

describe("Chronicle atomic review apply", () => {
  beforeEach(() => {
    commitMock.mockReset();
    commitMock.mockResolvedValue(1);
    __setCommitCoordinatorForTests({
      isCommitCoordinatorReady: () => true,
      applyChronicleExtractionCommit: commitMock,
    });
  });

  afterEach(() => {
    __setCommitCoordinatorForTests(null);
  });

  it.each(["unreviewed", "held", "deferred"] as const)(
    "rejects partial Apply while an actionable proposal is %s",
    async (status) => {
      const proposals = [
        proposal("proposal-a", { status: "approved" }),
        proposal("proposal-b", { status }),
      ];

      expect(getChronicleApplyReadiness(proposals)).toEqual({
        ready: false,
        approvedCount: 0,
        errorCode: "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE",
      });
      await expect(
        applyChronicleExtractionReview({
          projectId: "project-1",
          proposals,
        }),
      ).rejects.toThrow("NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE");
      expect(commitMock).not.toHaveBeenCalled();
    },
  );

  it("passes the complete review roster through and commits all approved proposals once", async () => {
    const proposals = [
      proposal("proposal-a", { status: "approved" }),
      proposal("proposal-b", { status: "approved" }),
      proposal("proposal-c", { status: "rejected" }),
    ];

    expect(selectChronicleProposalsForAtomicApply(proposals)).toEqual(
      proposals.slice(0, 2),
    );
    await expect(
      applyChronicleExtractionReview({ projectId: "project-1", proposals }),
    ).resolves.toBe(1);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledWith({
      projectId: "project-1",
      proposals,
    });
  });

  it("fails closed on a cold-restored partial legacy set", async () => {
    const applied = proposal("proposal-a", { status: "approved" });
    const proposals = [
      {
        ...applied,
        application: application(applied.revisionId ?? ""),
      },
      proposal("proposal-b", { status: "unreviewed" }),
    ];

    expect(getChronicleApplyReadiness(proposals)).toEqual({
      ready: false,
      approvedCount: 0,
      errorCode: "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH",
    });
    await expect(
      applyChronicleExtractionReview({ projectId: "project-1", proposals }),
    ).rejects.toThrow("NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH");
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("requires skip-as-same before a probable duplicate is terminally rejected", async () => {
    const bareRejected = proposal("proposal-duplicate", {
      status: "rejected",
      match: {
        status: "probable-duplicate",
        candidates: ["event-existing"],
        reasons: ["same-title"],
      },
    });

    expect(getChronicleApplyReadiness([bareRejected])).toEqual({
      ready: false,
      approvedCount: 0,
      errorCode: "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE",
    });
    await expect(
      applyChronicleExtractionReview({
        projectId: "project-1",
        proposals: [bareRejected],
      }),
    ).rejects.toThrow("NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE");

    await expect(
      applyChronicleExtractionReview({
        projectId: "project-1",
        proposals: [
          { ...bareRejected, probableDuplicateChoice: "skip-as-same" },
        ],
      }),
    ).resolves.toBe(0);
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("does not dispatch a commit when every proposal is rejected or already applied", async () => {
    const applied = proposal("proposal-a", { status: "approved" });
    const allApplied = [
      {
        ...applied,
        application: application(applied.revisionId ?? ""),
      },
    ];

    await expect(
      applyChronicleExtractionReview({
        projectId: "project-1",
        proposals: [proposal("proposal-r", { status: "rejected" })],
      }),
    ).resolves.toBe(0);
    await expect(
      applyChronicleExtractionReview({
        projectId: "project-1",
        proposals: allApplied,
      }),
    ).resolves.toBe(0);
    expect(commitMock).not.toHaveBeenCalled();
  });
});
