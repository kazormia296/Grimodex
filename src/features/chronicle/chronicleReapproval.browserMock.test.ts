// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createBrowserMock } from "@/lib/browser-mock";
import type {
  GetRunReviewBundleResult,
  ReapproveAppliedProposalsResult,
} from "@/application/narrative-extraction/nativeApi";

it("reads a removal rejection, reapproves it once and reads back the new decision", async () => {
  const proposalId = "proposal-a";
  const revisionId = "rev-a";
  const identity = { projectId: "project-a", runId: "run-a" };
  const removal = {
    rejectedBy: "event-removed",
    removedVia: "screen-delete",
    rejectedAt: "2026-11-26T00:00:00Z",
    reapproval: { available: true, reason: null },
  } as const;
  const mock = await createBrowserMock({
    chronicleReviewBundleForTest: {
      ...identity,
      artifacts: [],
      stageReceipts: [],
      proposalSet: null,
      proposals: [
        {
          proposalId,
          currentRevisionId: revisionId,
          proposalKey: "key-a",
          proposalSetId: "set-a",
          kind: "chronicle.create-event@1",
          payloadJson: {},
          status: "rejected",
          latestDecision: null,
          createdAt: removal.rejectedAt,
          updatedAt: removal.rejectedAt,
          application: {
            revisionId,
            commitId: "commit-a",
            appliedEntityKind: "chronicle-event",
            appliedEntityId: "event-a",
            createdAt: removal.rejectedAt,
            applicationKind: "normal",
            compensatesApplicationId: null,
          },
          ...removal,
        },
      ],
    },
  });
  const read = () =>
    mock.invoke<GetRunReviewBundleResult>(
      "narrative_extraction_get_run_review_bundle",
      { payload: identity },
    );
  const approve = (projectId = identity.projectId, revision = revisionId) =>
    mock.invoke<ReapproveAppliedProposalsResult>(
      "narrative_extraction_reapprove_applied_proposals",
      {
        payload: { projectId, targets: [{ proposalId, revisionId: revision }] },
      },
    );
  try {
    expect((await read()).proposals[0]).toMatchObject({
      status: "rejected",
      ...removal,
    });
    expect((await approve("other")).skipped).toEqual([
      { proposalId, reasons: ["proposal-not-found"] },
    ]);
    expect((await approve(identity.projectId, "other")).skipped).toEqual([
      { proposalId, reasons: ["revision-changed"] },
    ]);
    expect((await approve()).approved).toEqual([
      { proposalId, revisionId, decisionId: expect.any(String) },
    ]);
    expect((await read()).proposals[0]).toMatchObject({
      status: "approved",
      rejectedBy: null,
      removedVia: null,
      rejectedAt: null,
      reapproval: { available: false, reason: "already-approved" },
    });
    expect((await approve()).skipped).toEqual([
      { proposalId, reasons: ["already-approved"] },
    ]);
  } finally {
    mock.close();
  }
});
