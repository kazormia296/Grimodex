import { beforeEach, describe, expect, it } from "vitest";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  buildProposalSafetyFlags,
  isSafeForBulkApprove,
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
  type ChronicleExtractionReviewProjection,
  type ChronicleReviewProposal,
} from "./chronicleExtractionStore";

function payload(
  overrides: Partial<CreateChronicleEventProposalPayloadV1> = {},
): CreateChronicleEventProposalPayloadV1 {
  return {
    eventId: "event-1",
    title: "教会への砲撃",
    note: null,
    actuality: "actual",
    significance: "major",
    evidenceAnchorIds: ["anchor-1"],
    evidenceDocumentRefs: ["doc-1"],
    disclosure: { secret: true, revealDocumentRef: "doc-1" },
    unresolvedMetadata: {
      participantSurfaces: ["マルフーシャ"],
      locationSurface: "教会",
      temporalExpressions: [],
    },
    ...overrides,
  };
}

function proposal(
  overrides: Partial<ChronicleReviewProposal> = {},
): ChronicleReviewProposal {
  const basePayload = payload();
  return {
    proposalId: "proposal-1",
    revisionId: "rev-1",
    proposalKey: "key-1",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: basePayload.title,
    payload: basePayload,
    match: { status: "none" },
    evidence: [
      {
        anchorId: "anchor-1",
        quote: "教会の尖塔が砲撃で崩れ落ちた",
        documentRef: "doc-1",
        sceneId: "scene-1",
        sceneTitle: "教会籠城",
        method: "exact",
      },
    ],
    safety: buildProposalSafetyFlags({
      match: { status: "none" },
      actuality: "actual",
      evidenceMethods: ["exact"],
    }),
    probableDuplicateChoice: null,
    ...overrides,
  };
}

function projection(
  proposals: ChronicleReviewProposal[],
): ChronicleExtractionReviewProjection {
  return {
    runId: "run-1",
    projectId: "project-a",
    workspacePath: "/workspace-a",
    openRevision: 1,
    proposalSetId: "proposal-set-1",
    status: "completed",
    coverage: {
      mode: "complete",
      windowCount: 2,
      completedWindows: 2,
      gaps: [],
    },
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 9,
      failed: 0,
      cancelled: 0,
    },
    proposals,
  };
}

describe("isSafeForBulkApprove", () => {
  it("requires fresh + exact evidence + settled actuality + no duplicate + lossless + no deps + low risk", () => {
    const safe = buildProposalSafetyFlags({
      match: { status: "none" },
      actuality: "actual",
      evidenceMethods: ["exact"],
    });
    expect(isSafeForBulkApprove(safe)).toBe(true);

    expect(
      isSafeForBulkApprove({
        ...safe,
        noDuplicate: false,
      }),
    ).toBe(false);
    expect(
      isSafeForBulkApprove({
        ...safe,
        evidenceExact: false,
      }),
    ).toBe(false);
    expect(
      isSafeForBulkApprove({
        ...safe,
        riskLow: false,
      }),
    ).toBe(false);
  });
});

describe("chronicleExtractionStore", () => {
  beforeEach(() => {
    resetChronicleExtractionStoreForTests();
  });

  it("starts proposals as unreviewed and holds DB projection fields", () => {
    const store = useChronicleExtractionStore.getState();
    store.setProjection(projection([proposal()]));
    const next = useChronicleExtractionStore.getState().projection;
    expect(next?.runId).toBe("run-1");
    expect(next?.proposals[0]?.status).toBe("unreviewed");
    expect(next?.coverage.windowCount).toBe(2);
    expect(useChronicleExtractionStore.getState().selectedProposalId).toBe(
      "proposal-1",
    );
  });

  it("clears projection when workspace/project scope mismatches", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal()]));
    useChronicleExtractionStore.getState().clearIfScopeMismatch({
      projectId: "project-b",
      workspacePath: "/workspace-a",
      openRevision: 1,
    });
    expect(useChronicleExtractionStore.getState().projection).toBeNull();
  });

  it("keeps projection when scope matches", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal()]));
    useChronicleExtractionStore.getState().clearIfScopeMismatch({
      projectId: "project-a",
      workspacePath: "/workspace-a",
      openRevision: 1,
    });
    expect(useChronicleExtractionStore.getState().projection?.runId).toBe(
      "run-1",
    );
  });

  it("reviseProposalFields applies Native revision id and requires re-approval", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ status: "approved" })]));
    useChronicleExtractionStore
      .getState()
      .reviseProposalFields("proposal-1", "rev-native-2", {
        title: "撤退命令",
        secret: false,
      });
    const updated =
      useChronicleExtractionStore.getState().projection?.proposals[0];
    expect(updated?.status).toBe("unreviewed");
    expect(updated?.displayTitle).toBe("撤退命令");
    expect(updated?.payload?.disclosure.secret).toBe(false);
    expect(updated?.revisionId).toBe("rev-native-2");
  });

  it("bulkApproveSafe only approves safe unreviewed proposals", () => {
    const safe = proposal({ proposalId: "safe" });
    const unsafe = proposal({
      proposalId: "dup",
      match: {
        status: "probable-duplicate",
        candidates: ["event-old"],
        reasons: ["title"],
      },
      safety: buildProposalSafetyFlags({
        match: {
          status: "probable-duplicate",
          candidates: ["event-old"],
          reasons: ["title"],
        },
        actuality: "actual",
        evidenceMethods: ["exact"],
      }),
    });
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([safe, unsafe]));
    const count = useChronicleExtractionStore.getState().bulkApproveSafe();
    expect(count).toBe(1);
    const statuses = useChronicleExtractionStore
      .getState()
      .projection?.proposals.map((item) => [item.proposalId, item.status]);
    expect(statuses).toEqual([
      ["safe", "approved"],
      ["dup", "unreviewed"],
    ]);
  });

  it("treats already-satisfied as non-actionable", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          proposalId: "done",
          applicability: "already-satisfied",
          status: "approved",
          payload: null,
          match: { status: "already-satisfied", existingRef: "event-old" },
        }),
      ]),
    );
    useChronicleExtractionStore
      .getState()
      .updateProposalStatus("done", "rejected");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("approved");
  });

  it("probable-duplicate choices map to skip / create / hold", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          match: {
            status: "probable-duplicate",
            candidates: ["event-old"],
            reasons: ["title"],
          },
        }),
      ]),
    );
    const store = useChronicleExtractionStore.getState();
    store.setProbableDuplicateChoice("proposal-1", "skip-as-same");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("rejected");
    store.setProbableDuplicateChoice("proposal-1", "create-as-new");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]
        ?.probableDuplicateChoice,
    ).toBe("create-as-new");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("approved");
    store.setProbableDuplicateChoice("proposal-1", "hold");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("held");
  });
});
