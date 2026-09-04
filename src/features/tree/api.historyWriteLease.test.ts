// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  createNode,
  deleteNode,
  historyWriteContext,
  treeWriteReceipt,
} from "./api";
import {
  _resetTimelapseGenesisBarriersForTests,
  beginTimelapseGenesisBarrier,
} from "@/features/timelapse/genesisBarrier";

describe("Tree canonical history identity lease", () => {
  it("reuses identity after an unknown outcome and rotates only after success", async () => {
    const id = `tree-history-lease-${crypto.randomUUID()}`;
    const created = await createNode({
      id,
      projectId: "default-project",
      parentId: null,
      nodeType: "scene",
      title: "History lease",
      sortOrder: "z9",
    });
    const receipt = treeWriteReceipt(created);
    expect(receipt).toBeDefined();

    const firstAttempt = historyWriteContext("undo", receipt);
    const unknownOutcomeRetry = historyWriteContext("undo", receipt);
    expect(unknownOutcomeRetry).toBe(firstAttempt);
    expect(firstAttempt).toMatchObject({
      origin: "undo",
      originalTransactionId: receipt!.maintenanceTransactionId,
      undoJournalId: receipt!.undoJournalId,
    });

    await deleteNode(id, "default-project", {
      writeContext: firstAttempt,
    });

    const nextHistoryCycle = historyWriteContext("undo", receipt);
    expect(nextHistoryCycle.requestId).not.toBe(firstAttempt.requestId);
    expect(nextHistoryCycle.eventUid).not.toBe(firstAttempt.eventUid);
    expect(nextHistoryCycle).toMatchObject({
      origin: "undo",
      originalTransactionId: receipt!.maintenanceTransactionId,
      undoJournalId: receipt!.undoJournalId,
    });
  });

  it("holds a tree cascade deletion behind genesis", async () => {
    _resetTimelapseGenesisBarriersForTests();
    const id = `tree-genesis-delete-${crypto.randomUUID()}`;
    await createNode({
      id,
      projectId: "default-project",
      parentId: null,
      nodeType: "scene",
      title: "Genesis delete",
      sortOrder: "z9",
    });
    const genesis = beginTimelapseGenesisBarrier("default-project");
    const deleting = deleteNode(id, "default-project");
    let settled = false;
    void deleting.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    genesis.complete();
    await deleting;
    expect(settled).toBe(true);
  });
});
