import { beforeEach, describe, expect, it, vi } from "vitest";

const getRunReviewBundleMock = vi.hoisted(() => vi.fn());
const bulkApproveMock = vi.hoisted(() => vi.fn());
const appendHumanDecisionMock = vi.hoisted(() => vi.fn());
const createHumanDerivedRevisionMock = vi.hoisted(() => vi.fn());
const coordinatorMock = vi.hoisted(() => vi.fn());
const loadArtifactMock = vi.hoisted(() => vi.fn());
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
      narrativeExtractionChronicleBulkApprove: bulkApproveMock,
    };
  },
);

vi.mock(
  "@/application/narrative-extraction/proposalRepository",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/application/narrative-extraction/proposalRepository")
      >();
    return {
      ...actual,
      appendHumanDecision: appendHumanDecisionMock,
      createHumanDerivedRevision: createHumanDerivedRevisionMock,
    };
  },
);

vi.mock("@/application/narrative-extraction/extractionCoordinator", () => ({
  runChronicleExtractionCoordinator: coordinatorMock,
}));

vi.mock("@/application/narrative-extraction/artifactRepository", () => ({
  loadInlineJsonArtifact: loadArtifactMock,
  hydrateInlineArtifactsFromNative: vi.fn(),
}));

vi.mock("@/application/narrative-extraction/runRepository", () => ({
  getRun: getRunMock,
  listChronicleTaskResumeCandidates: vi.fn(),
  listResumableRuns: vi.fn(),
}));

import type { ReviewBundleProposal } from "@/application/narrative-extraction/nativeApi";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import {
  bulkApproveChronicleProposals,
  ChronicleBulkApproveCommandError,
  CHRONICLE_BULK_APPROVE_MAX_TARGETS,
  decideChronicleProposal,
  refreshChronicleBulkApprovalJudgements,
  resetChronicleExtractionApiCachesForTests,
  reviseChronicleProposal,
  startChronicleExtraction,
} from "./chronicleExtractionApi";
import {
  buildProposalSafetyFlags,
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
  type ChronicleExtractionReviewProjection,
  type ChronicleReviewProposal,
} from "./chronicleExtractionStore";

function payload(
  eventId: string,
  secret = true,
): CreateChronicleEventProposalPayloadV1 {
  return {
    eventId,
    title: `title-${eventId}`,
    note: null,
    actuality: "actual",
    significance: "scene-level",
    evidenceAnchorIds: ["anchor-1"],
    evidenceDocumentRefs: ["doc-1"],
    disclosure: { secret, revealDocumentRef: "doc-1" },
    unresolvedMetadata: {
      participantSurfaces: [],
      locationSurface: null,
      temporalExpressions: [],
    },
  };
}

const ELIGIBLE = { eligible: true, reasons: [] } as const;

function proposal(
  id: string,
  overrides: Partial<ChronicleReviewProposal> = {},
): ChronicleReviewProposal {
  const base = payload(id);
  return {
    proposalId: id,
    revisionId: `rev-${id}`,
    reconciliationEnvelopeDigest: `sha256:${"a".repeat(64)}`,
    reconciliationEnvelopeSchemaVersion: 2,
    proposalKey: `key-${id}`,
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: base.title,
    payload: base,
    plannedTitle: base.title,
    plannedMatch: { status: "none" },
    match: { status: "none" },
    evidence: [],
    safety: buildProposalSafetyFlags({
      match: { status: "none" },
      actuality: "actual",
      evidenceMethods: ["exact"],
    }),
    probableDuplicateChoice: null,
    application: null,
    bulkApproval: null,
    ...overrides,
  };
}

function projection(
  proposals: ChronicleReviewProposal[],
  overrides: Partial<ChronicleExtractionReviewProjection> = {},
): ChronicleExtractionReviewProjection {
  return {
    runId: "run-1",
    projectId: "project-a",
    workspacePath: "/workspace-a",
    openRevision: 1,
    proposalSetId: "set-1",
    status: "completed",
    coverage: {},
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
    },
    proposals,
    ...overrides,
  };
}

function nativeRow(
  id: string,
  overrides: Partial<ReviewBundleProposal> = {},
): ReviewBundleProposal {
  return {
    proposalId: id,
    proposalSetId: "set-1",
    proposalKey: `key-${id}`,
    kind: "create_chronicle_event",
    status: "unreviewed",
    payloadJson: payload(id) as unknown as Record<string, unknown>,
    currentRevisionId: `rev-${id}`,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
    latestDecision: null,
    reconciliationEnvelopeDigest: `sha256:${"a".repeat(64)}`,
    reconciliationEnvelopeSchemaVersion: 2,
    bulkApproval: ELIGIBLE,
    ...overrides,
  };
}

function bundle(rows: ReviewBundleProposal[]) {
  return {
    runId: "run-1",
    projectId: "project-a",
    artifacts: [],
    stageReceipts: [],
    proposalSet: null,
    proposals: rows,
  };
}

function rowsInStore() {
  return useChronicleExtractionStore.getState().projection?.proposals ?? [];
}

describe("Chronicle bulk approve (BAO/1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChronicleExtractionApiCachesForTests();
    resetChronicleExtractionStoreForTests();
  });

  describe("bulkApproveChronicleProposals", () => {
    it("sends only Native-eligible {proposalId, revisionId} once, then re-reads and updates the projection", async () => {
      useChronicleExtractionStore.getState().setProjection(
        projection([
          proposal("a", { bulkApproval: ELIGIBLE }),
          // Plan-time flags are green but there is no judgement: not sent.
          proposal("b", { bulkApproval: null }),
          proposal("c", {
            bulkApproval: { eligible: false, reasons: ["r3-significance"] },
          }),
          proposal("d", { bulkApproval: ELIGIBLE }),
        ]),
      );
      useChronicleExtractionStore.getState().selectProposal("c");
      bulkApproveMock.mockResolvedValue({
        approved: [
          { proposalId: "a", revisionId: "rev-a-child", decisionId: "d-a" },
          { proposalId: "d", revisionId: "rev-d-child", decisionId: "d-d" },
        ],
        skipped: [],
        failed: [],
        stopped: false,
      });
      getRunReviewBundleMock.mockResolvedValue(
        bundle([
          nativeRow("a", {
            status: "approved",
            currentRevisionId: "rev-a-child",
            payloadJson: payload("a", false) as unknown as Record<
              string,
              unknown
            >,
            reconciliationEnvelopeDigest: `sha256:${"b".repeat(64)}`,
            bulkApproval: { eligible: false, reasons: ["approved", "edited"] },
          }),
          nativeRow("b", { bulkApproval: ELIGIBLE }),
          nativeRow("c", {
            bulkApproval: { eligible: false, reasons: ["r3-significance"] },
          }),
          nativeRow("d", {
            status: "approved",
            currentRevisionId: "rev-d-child",
            payloadJson: payload("d", false) as unknown as Record<
              string,
              unknown
            >,
            reconciliationEnvelopeDigest: `sha256:${"c".repeat(64)}`,
            bulkApproval: { eligible: false, reasons: ["approved", "edited"] },
          }),
        ]),
      );

      const outcome = await bulkApproveChronicleProposals();

      expect(bulkApproveMock).toHaveBeenCalledTimes(1);
      expect(bulkApproveMock).toHaveBeenCalledWith({
        projectId: "project-a",
        runId: "run-1",
        targets: [
          { proposalId: "a", revisionId: "rev-a" },
          { proposalId: "d", revisionId: "rev-d" },
        ],
      });
      expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);
      const rows = rowsInStore();
      expect(rows.map((row) => [row.proposalId, row.status])).toEqual([
        ["a", "approved"],
        ["b", "unreviewed"],
        ["c", "unreviewed"],
        ["d", "approved"],
      ]);
      expect(rows[0]).toMatchObject({
        revisionId: "rev-a-child",
        reconciliationEnvelopeDigest: `sha256:${"b".repeat(64)}`,
      });
      expect(rows[0]?.payload?.disclosure.secret).toBe(false);
      // b becomes a target only because Native now says so.
      expect(rows[1]?.bulkApproval?.eligible).toBe(true);
      // The author's selection is not rolled back.
      expect(useChronicleExtractionStore.getState().selectedProposalId).toBe(
        "c",
      );
      expect(outcome).toMatchObject({
        runId: "run-1",
        approved: 2,
        skipped: [],
        failed: [],
        stopped: false,
        notSent: 0,
        refreshed: true,
        remaining: 2,
      });
    });

    it("does not call Native when no proposal is a target", async () => {
      useChronicleExtractionStore.getState().setProjection(
        projection([
          proposal("a", { bulkApproval: null }),
          proposal("b", {
            bulkApproval: { eligible: false, reasons: ["held"] },
          }),
        ]),
      );
      const outcome = await bulkApproveChronicleProposals();
      expect(bulkApproveMock).not.toHaveBeenCalled();
      expect(getRunReviewBundleMock).not.toHaveBeenCalled();
      expect(outcome.approved).toBe(0);
    });

    it("returns skipped / failed / stopped as Native reported them", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(
          projection([
            proposal("a", { bulkApproval: ELIGIBLE }),
            proposal("b", { bulkApproval: ELIGIBLE }),
            proposal("c", { bulkApproval: ELIGIBLE }),
          ]),
        );
      bulkApproveMock.mockResolvedValue({
        approved: [],
        skipped: [{ proposalId: "a", reasons: ["revision-changed"] }],
        failed: [{ proposalId: "b", code: "NEX_X" }],
        stopped: true,
      });
      getRunReviewBundleMock.mockResolvedValue(
        bundle([nativeRow("a"), nativeRow("b"), nativeRow("c")]),
      );
      const outcome = await bulkApproveChronicleProposals();
      expect(outcome).toMatchObject({
        approved: 0,
        skipped: [{ proposalId: "a", reasons: ["revision-changed"] }],
        failed: [{ proposalId: "b", code: "NEX_X" }],
        stopped: true,
      });
    });

    it("re-reads and rethrows when the whole command fails", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a", { bulkApproval: ELIGIBLE })]));
      bulkApproveMock.mockRejectedValue(new Error("NEX_BULK_DOWN"));
      getRunReviewBundleMock.mockResolvedValue(
        bundle([
          nativeRow("a", {
            bulkApproval: { eligible: false, reasons: ["edited"] },
          }),
        ]),
      );
      await expect(bulkApproveChronicleProposals()).rejects.toThrow(
        "NEX_BULK_DOWN",
      );
      expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);
      expect(rowsInStore()[0]?.bulkApproval).toEqual({
        eligible: false,
        reasons: ["edited"],
      });
    });

    it("makes judgements unknown when the re-read fails, and mirrors what Native approved", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(
          projection([
            proposal("a", { bulkApproval: ELIGIBLE }),
            proposal("b", { bulkApproval: ELIGIBLE }),
          ]),
        );
      bulkApproveMock.mockResolvedValue({
        approved: [
          { proposalId: "a", revisionId: "rev-a-child", decisionId: "d-a" },
        ],
        skipped: [{ proposalId: "b", reasons: ["revision-changed"] }],
        failed: [],
        stopped: false,
      });
      getRunReviewBundleMock.mockRejectedValue(new Error("read failed"));
      const outcome = await bulkApproveChronicleProposals();
      expect(outcome.refreshed).toBe(false);
      const rows = rowsInStore();
      expect(rows[0]).toMatchObject({
        status: "approved",
        revisionId: "rev-a-child",
        bulkApproval: null,
      });
      expect(rows[0]?.payload?.disclosure.secret).toBe(false);
      expect(rows[1]).toMatchObject({
        status: "unreviewed",
        bulkApproval: null,
      });
      // Unknown judgement: nothing is sent next time.
      const again = await bulkApproveChronicleProposals();
      expect(again.approved).toBe(0);
      expect(bulkApproveMock).toHaveBeenCalledTimes(1);
    });

    it("does not apply the result to a projection of another project", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a", { bulkApproval: ELIGIBLE })]));
      bulkApproveMock.mockImplementation(async () => {
        // The dialog scope changed while the command ran.
        useChronicleExtractionStore.getState().setProjection(
          projection([proposal("z", { bulkApproval: null })], {
            projectId: "project-b",
            runId: "run-other",
          }),
        );
        return {
          approved: [
            { proposalId: "a", revisionId: "rev-a-child", decisionId: "d-a" },
          ],
          skipped: [],
          failed: [],
          stopped: false,
        };
      });
      getRunReviewBundleMock.mockResolvedValue(bundle([nativeRow("a")]));
      await bulkApproveChronicleProposals();
      const state = useChronicleExtractionStore.getState().projection;
      expect(state?.projectId).toBe("project-b");
      expect(state?.proposals.map((row) => row.proposalId)).toEqual(["z"]);
      expect(state?.proposals[0]?.bulkApproval).toBeNull();
    });

    it("sends at most the command's limit and reports the rest", async () => {
      const many = Array.from(
        { length: CHRONICLE_BULK_APPROVE_MAX_TARGETS + 3 },
        (_, index) => proposal(`p${index}`, { bulkApproval: ELIGIBLE }),
      );
      useChronicleExtractionStore.getState().setProjection(projection(many));
      bulkApproveMock.mockResolvedValue({
        approved: [],
        skipped: [],
        failed: [],
        stopped: false,
      });
      getRunReviewBundleMock.mockResolvedValue(bundle([]));
      const outcome = await bulkApproveChronicleProposals();
      expect(bulkApproveMock.mock.calls[0]?.[0].targets.length).toBe(
        CHRONICLE_BULK_APPROVE_MAX_TARGETS,
      );
      expect(outcome.notSent).toBe(3);
    });
  });

  describe("judgement re-read after one-at-a-time operations", () => {
    it("re-reads once after a decision and updates every proposal's judgement", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(
          projection([
            proposal("a", { bulkApproval: ELIGIBLE }),
            proposal("b", { bulkApproval: ELIGIBLE }),
          ]),
        );
      useChronicleExtractionStore.getState().selectProposal("b");
      appendHumanDecisionMock.mockResolvedValue({});
      getRunReviewBundleMock.mockResolvedValue(
        bundle([
          nativeRow("a", {
            status: "rejected",
            bulkApproval: { eligible: false, reasons: ["rejected"] },
          }),
          nativeRow("b", {
            bulkApproval: { eligible: false, reasons: ["set-applied"] },
          }),
        ]),
      );
      await decideChronicleProposal({ proposalId: "a", status: "rejected" });
      expect(appendHumanDecisionMock).toHaveBeenCalledTimes(1);
      expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);
      const rows = rowsInStore();
      expect(rows.map((row) => row.status)).toEqual(["rejected", "unreviewed"]);
      expect(rows.map((row) => row.bulkApproval?.reasons)).toEqual([
        ["rejected"],
        ["set-applied"],
      ]);
      expect(useChronicleExtractionStore.getState().selectedProposalId).toBe(
        "b",
      );
    });

    it("makes judgements unknown when the re-read fails, without failing the decision", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(
          projection([
            proposal("a", { bulkApproval: ELIGIBLE }),
            proposal("b", { bulkApproval: ELIGIBLE }),
          ]),
        );
      appendHumanDecisionMock.mockResolvedValue({});
      getRunReviewBundleMock.mockRejectedValue(new Error("read failed"));
      await expect(
        decideChronicleProposal({ proposalId: "a", status: "held" }),
      ).resolves.toBeUndefined();
      const rows = rowsInStore();
      expect(rows[0]?.status).toBe("held");
      expect(rows.map((row) => row.bulkApproval ?? null)).toEqual([null, null]);
    });

    it("does not re-read when the decision itself failed", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a", { bulkApproval: ELIGIBLE })]));
      appendHumanDecisionMock.mockRejectedValue(new Error("write failed"));
      await expect(
        decideChronicleProposal({ proposalId: "a", status: "approved" }),
      ).rejects.toThrow("write failed");
      expect(getRunReviewBundleMock).not.toHaveBeenCalled();
      expect(rowsInStore()[0]?.bulkApproval).toEqual(ELIGIBLE);
    });

    it("re-reads once after an edit (child revision) and shows Native's 'edited'", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a", { bulkApproval: ELIGIBLE })]));
      createHumanDerivedRevisionMock.mockResolvedValue({
        revisionId: "rev-a-2",
        reconciliationEnvelopeDigest: `sha256:${"d".repeat(64)}`,
      });
      getRunReviewBundleMock.mockResolvedValue(
        bundle([
          nativeRow("a", {
            currentRevisionId: "rev-a-2",
            bulkApproval: { eligible: false, reasons: ["edited"] },
          }),
        ]),
      );
      await reviseChronicleProposal({
        proposalId: "a",
        patch: { note: "メモ" },
      });
      expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);
      expect(rowsInStore()[0]).toMatchObject({
        revisionId: "rev-a-2",
        bulkApproval: { eligible: false, reasons: ["edited"] },
      });
    });
  });

  describe("stale answers and revision match", () => {
    it("drops an older read that is answered after a one-at-a-time operation", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(
          projection([
            proposal("a", { bulkApproval: ELIGIBLE }),
            proposal("b", { bulkApproval: ELIGIBLE }),
          ]),
        );
      let release: (value: ReturnType<typeof bundle>) => void = () => {};
      getRunReviewBundleMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const slow = refreshChronicleBulkApprovalJudgements();
      appendHumanDecisionMock.mockResolvedValue({});
      getRunReviewBundleMock.mockResolvedValueOnce(
        bundle([
          nativeRow("a", {
            status: "rejected",
            bulkApproval: { eligible: false, reasons: ["rejected"] },
          }),
          nativeRow("b"),
        ]),
      );
      await decideChronicleProposal({ proposalId: "a", status: "rejected" });
      // The older answer still says "a" is eligible.
      release(bundle([nativeRow("a"), nativeRow("b")]));
      await slow;
      expect(rowsInStore()[0]?.bulkApproval).toEqual({
        eligible: false,
        reasons: ["rejected"],
      });
    });

    it("does not let an older read bring back a judgement nulled by a local operation", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a", { bulkApproval: ELIGIBLE })]));
      let release: (value: ReturnType<typeof bundle>) => void = () => {};
      getRunReviewBundleMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const slow = refreshChronicleBulkApprovalJudgements();
      useChronicleExtractionStore.getState().updateProposalStatus("a", "held");
      release(bundle([nativeRow("a")]));
      await slow;
      expect(rowsInStore()[0]).toMatchObject({
        status: "held",
        bulkApproval: null,
      });
    });

    it("copies a judgement only to a proposal whose current revision is the one Native judged", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(
          projection([
            proposal("a"),
            proposal("b", { revisionId: "rev-b-old" }),
          ]),
        );
      getRunReviewBundleMock.mockResolvedValue(
        bundle([nativeRow("a"), nativeRow("b")]),
      );
      await refreshChronicleBulkApprovalJudgements();
      const rows = rowsInStore();
      expect(rows[0]?.bulkApproval).toEqual(ELIGIBLE);
      expect(rows[1]?.bulkApproval).toBeNull();
    });
  });

  describe("overlapping re-reads", () => {
    it("does not mirror over a newer read that answered while the bulk re-read was pending", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(
          projection([
            proposal("a", { bulkApproval: ELIGIBLE }),
            proposal("b", { bulkApproval: ELIGIBLE }),
          ]),
        );
      bulkApproveMock.mockResolvedValue({
        approved: [
          { proposalId: "a", revisionId: "rev-a-child", decisionId: "d" },
        ],
        skipped: [],
        failed: [],
        stopped: false,
      });
      const after = bundle([
        nativeRow("a", {
          status: "approved",
          currentRevisionId: "rev-a-child",
          payloadJson: payload("a", false) as unknown as Record<
            string,
            unknown
          >,
          reconciliationEnvelopeDigest: `sha256:${"b".repeat(64)}`,
          bulkApproval: { eligible: false, reasons: ["approved", "edited"] },
        }),
        nativeRow("b"),
      ]);
      let releaseBulkRead: (
        value: ReturnType<typeof bundle>,
      ) => void = () => {};
      getRunReviewBundleMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseBulkRead = resolve;
          }),
      );
      const bulk = bulkApproveChronicleProposals();
      await vi.waitFor(() =>
        expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1),
      );
      // Another re-read starts after the write and answers first.
      getRunReviewBundleMock.mockResolvedValueOnce(after);
      await refreshChronicleBulkApprovalJudgements({ syncRevisions: true });
      releaseBulkRead(after);
      const outcome = await bulk;
      expect(outcome.refreshed).toBe(true);
      const rows = rowsInStore();
      expect(rows[0]).toMatchObject({
        status: "approved",
        revisionId: "rev-a-child",
        reconciliationEnvelopeDigest: `sha256:${"b".repeat(64)}`,
      });
      expect(rows[1]?.bulkApproval).toEqual(ELIGIBLE);
    });

    it("lets a failed bulk re-read yield to a newer successful one", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a", { bulkApproval: ELIGIBLE })]));
      let rejectOld: (reason: unknown) => void = () => {};
      getRunReviewBundleMock.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      );
      const old = refreshChronicleBulkApprovalJudgements();
      getRunReviewBundleMock.mockResolvedValueOnce(bundle([nativeRow("a")]));
      await refreshChronicleBulkApprovalJudgements();
      rejectOld(new Error("late failure"));
      await expect(old).resolves.toBe(true);
      expect(rowsInStore()[0]?.bulkApproval).toEqual(ELIGIBLE);
    });

    it("mirrorBulkApproved advances the generation and keeps an already synced row", () => {
      useChronicleExtractionStore.getState().setProjection(
        projection([
          proposal("a", {
            revisionId: "rev-a-child",
            status: "approved",
            reconciliationEnvelopeDigest: `sha256:${"b".repeat(64)}`,
          }),
        ]),
      );
      const before = useChronicleExtractionStore.getState().bulkJudgementEpoch;
      useChronicleExtractionStore.getState().mirrorBulkApproved(
        {
          runId: "run-1",
          projectId: "project-a",
          workspacePath: "/workspace-a",
          openRevision: 1,
        },
        [{ proposalId: "a", revisionId: "rev-a-child" }],
      );
      expect(useChronicleExtractionStore.getState().bulkJudgementEpoch).toBe(
        before + 1,
      );
      expect(rowsInStore()[0]?.reconciliationEnvelopeDigest).toBe(
        `sha256:${"b".repeat(64)}`,
      );
    });
  });

  describe("projection replacement and sync", () => {
    it("setProjection advances the generation so an older answer is dropped", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a")]));
      let release: (value: ReturnType<typeof bundle>) => void = () => {};
      getRunReviewBundleMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const slow = refreshChronicleBulkApprovalJudgements();
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a")]));
      release(bundle([nativeRow("a")]));
      await slow;
      expect(rowsInStore()[0]?.bulkApproval).toBeNull();
    });

    it("does not overwrite a row whose revision already equals the synced one", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(
          projection([
            proposal("a", { revisionId: "rev-a-child", status: "held" }),
          ]),
        );
      getRunReviewBundleMock.mockImplementation(async () => {
        // Native read says current revision differs at read time...
        return bundle([nativeRow("a", { currentRevisionId: "rev-a-child" })]);
      });
      await refreshChronicleBulkApprovalJudgements({ syncRevisions: true });
      expect(rowsInStore()[0]?.status).toBe("held");
    });
  });

  describe("whole-command failure", () => {
    it("tells whether the list could be re-read", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a", { bulkApproval: ELIGIBLE })]));
      bulkApproveMock.mockRejectedValue(new Error("NEX_BULK_DOWN"));
      getRunReviewBundleMock.mockRejectedValue(new Error("read failed"));
      const failed = await bulkApproveChronicleProposals().catch(
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(ChronicleBulkApproveCommandError);
      expect((failed as ChronicleBulkApproveCommandError).listRefreshed).toBe(
        false,
      );
    });

    it("says to re-read when an edit follows a mirrored bulk approval", async () => {
      useChronicleExtractionStore.getState().setProjection(
        projection([
          proposal("a", {
            status: "approved",
            reconciliationEnvelopeDigest: null,
          }),
        ]),
      );
      await expect(
        reviseChronicleProposal({ proposalId: "a", patch: { title: "新" } }),
      ).rejects.toThrow("一覧を読み直してから、もう一度試してください");
    });
  });

  describe("refreshChronicleBulkApprovalJudgements", () => {
    it("treats a bundle without judgements (not a current Chronicle Run) as unknown", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a", { bulkApproval: ELIGIBLE })]));
      getRunReviewBundleMock.mockResolvedValue(
        bundle([nativeRow("a", { bulkApproval: undefined })]),
      );
      await expect(refreshChronicleBulkApprovalJudgements()).resolves.toBe(
        true,
      );
      expect(rowsInStore()[0]?.bulkApproval).toBeNull();
    });

    it("treats a bundle for another Run as a failed read", async () => {
      useChronicleExtractionStore
        .getState()
        .setProjection(projection([proposal("a", { bulkApproval: ELIGIBLE })]));
      getRunReviewBundleMock.mockResolvedValue({
        ...bundle([nativeRow("a")]),
        runId: "run-other",
      });
      await expect(refreshChronicleBulkApprovalJudgements()).resolves.toBe(
        false,
      );
      expect(rowsInStore()[0]?.bulkApproval).toBeNull();
    });
  });

  describe("right after an extraction", () => {
    it("reads Native's judgement once and puts it into the projection", async () => {
      loadArtifactMock.mockResolvedValue(null);
      getRunMock.mockResolvedValue({
        run: { status: "completed", coverageJson: {} },
        taskCounts: {
          queued: 0,
          running: 0,
          completed: 1,
          failed: 0,
          cancelled: 0,
        },
      });
      const body = payload("event-1");
      coordinatorMock.mockResolvedValue({
        runId: "run-1",
        snapshot: { documents: [] },
        proposals: [body],
        savedProposalSetId: "set-1",
        savedProposals: [
          {
            proposalId: "proposal-1",
            proposalKey: "event-1:0",
            revisionId: "rev-1",
            status: "unreviewed",
            payload: body,
          },
        ],
      });
      getRunReviewBundleMock.mockResolvedValue(
        bundle([
          nativeRow("proposal-1", {
            currentRevisionId: "rev-1",
            bulkApproval: { eligible: false, reasons: ["r4-actuality"] },
          }),
        ]),
      );
      await startChronicleExtraction({
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-1"],
        authority: {
          projectId: "project-a",
          currentProjectId: () => "project-a",
          workspacePath: "/workspace-a",
          workspaceOpenRevision: 1,
        },
        workspacePath: "/workspace-a",
        openRevision: 1,
        useAi: false,
      });
      expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);
      expect(rowsInStore()[0]?.bulkApproval).toEqual({
        eligible: false,
        reasons: ["r4-actuality"],
      });
    });

    it("leaves the judgement unknown when the read fails", async () => {
      loadArtifactMock.mockResolvedValue(null);
      getRunMock.mockResolvedValue({
        run: { status: "completed", coverageJson: {} },
        taskCounts: {
          queued: 0,
          running: 0,
          completed: 1,
          failed: 0,
          cancelled: 0,
        },
      });
      const body = payload("event-1");
      coordinatorMock.mockResolvedValue({
        runId: "run-1",
        snapshot: { documents: [] },
        proposals: [body],
        savedProposalSetId: "set-1",
        savedProposals: [
          {
            proposalId: "proposal-1",
            proposalKey: "event-1:0",
            revisionId: "rev-1",
            status: "unreviewed",
            payload: body,
          },
        ],
      });
      getRunReviewBundleMock.mockRejectedValue(new Error("read failed"));
      await startChronicleExtraction({
        projectId: "project-a",
        folderId: "folder-1",
        language: "ja",
        sceneIds: ["scene-1"],
        authority: {
          projectId: "project-a",
          currentProjectId: () => "project-a",
          workspacePath: "/workspace-a",
          workspaceOpenRevision: 1,
        },
        workspacePath: "/workspace-a",
        openRevision: 1,
        useAi: false,
      });
      expect(rowsInStore()[0]?.bulkApproval ?? null).toBeNull();
    });
  });
});
