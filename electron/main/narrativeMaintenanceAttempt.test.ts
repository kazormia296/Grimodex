import { describe, expect, it } from "vitest";

import {
  createNarrativeMaintenanceAttemptController,
  NARRATIVE_MAINTENANCE_MAX_TERMINAL_RECEIPTS,
  parseNarrativeMaintenanceBeginReceipt,
  parseNarrativeMaintenanceTerminalReceipt,
  type NarrativeMaintenanceAttemptController,
} from "./narrativeMaintenanceAttempt.js";

const binding = { authorityId: "authority-a", generation: 7 };

function controller(): NarrativeMaintenanceAttemptController {
  return createNarrativeMaintenanceAttemptController();
}

describe("narrative maintenance attempt linearization", () => {
  it("accepts a Native begin receipt only when it carries the exact binding", () => {
    expect(
      parseNarrativeMaintenanceBeginReceipt({
        status: "open",
        attemptId: "attempt-native",
        authorityId: binding.authorityId,
        generation: binding.generation,
      }),
    ).toEqual({
      status: "open",
      attemptId: "attempt-native",
      authorityId: binding.authorityId,
      generation: binding.generation,
    });
    expect(() =>
      parseNarrativeMaintenanceBeginReceipt({
        status: "open",
        attemptId: "attempt-native",
        authorityId: binding.authorityId,
        generation: binding.generation + 1,
      }),
    ).not.toThrow();
  });

  it("keeps run creation open until the finalization transition", async () => {
    const attempts = controller();
    attempts.begin("attempt-a", binding);
    attempts.addWork("attempt-a", "work-a");

    const cancel = attempts.requestStop("attempt-a", "cancelled");
    expect(attempts.snapshot("attempt-a")?.state).toBe("stop-requested");
    expect(attempts.grantFinalize("attempt-a")).toBe(false);

    const receipt = attempts.settle("attempt-a", { state: "succeeded" });
    expect(receipt.state).toBe("interrupted");
    expect(receipt.stopReason).toBe("cancelled");
    await expect(cancel).resolves.toEqual(receipt);
  });

  it("lets finalization win when it linearizes before a late cancel", async () => {
    const attempts = controller();
    attempts.begin("attempt-b", binding);
    attempts.addWork("attempt-b", "work-a");
    expect(attempts.grantFinalize("attempt-b")).toBe(true);

    const cancel = attempts.requestStop("attempt-b", "cancelled");
    let settled = false;
    void cancel.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const receipt = attempts.settle("attempt-b", {
      state: "succeeded",
      publishedGeneration: 8,
    });
    await expect(cancel).resolves.toEqual(receipt);
    expect(receipt.state).toBe("succeeded");
    expect(receipt.stopReason).toBeNull();
    expect(receipt.publishedGeneration).toBe(8);
  });

  it("preserves completed work when a later work is interrupted", async () => {
    const attempts = controller();
    attempts.begin("attempt-c", binding);
    attempts.retainOwner("attempt-c");
    attempts.addWork("attempt-c", "work-a");
    attempts.addWork("attempt-c", "work-b");
    attempts.markWorkStarted("attempt-c", "work-a");
    attempts.grantFinalize("attempt-c");
    attempts.settle("attempt-c", { state: "succeeded" });
    const first = attempts.snapshot("attempt-c");
    expect(first?.works).toEqual([
      { workKey: "work-a", status: "succeeded" },
      { workKey: "work-b", status: "succeeded" },
    ]);
    attempts.releaseOwner("attempt-c");

    attempts.begin("attempt-d", binding);
    attempts.retainOwner("attempt-d");
    attempts.addWork("attempt-d", "work-a");
    attempts.addWork("attempt-d", "work-b");
    attempts.markWorkStarted("attempt-d", "work-a");
    attempts.settle("attempt-d", {
      state: "interrupted",
      publishedGeneration: null,
    });
    expect(attempts.snapshot("attempt-d")?.works).toEqual([
      { workKey: "work-a", status: "interrupted" },
      { workKey: "work-b", status: "not-started" },
    ]);
    attempts.releaseOwner("attempt-d");
  });

  it("settles begin/cancel without a native work and rejects binding reuse", async () => {
    const attempts = controller();
    attempts.begin("attempt-e", binding);
    await expect(attempts.requestStop("attempt-e", "closed")).resolves.toMatchObject({
      state: "interrupted",
      stopReason: "closed",
      connectionReusable: true,
    });
    expect(() => attempts.begin("attempt-e", { ...binding, generation: 8 })).toThrow(
      /binding conflict|terminally cached/,
    );
  });

  it("waits for a Native receipt before terminalizing an empty Native-owned attempt", async () => {
    const attempts = controller();
    attempts.begin("attempt-native-empty", binding);
    attempts.retainOwner("attempt-native-empty");
    attempts.markNativeOwned("attempt-native-empty");

    const cancellation = attempts.requestStop(
      "attempt-native-empty",
      "closed",
    );
    let resolved = false;
    void cancellation.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    const receipt = parseNarrativeMaintenanceTerminalReceipt({
      schemaVersion: 1,
      attemptId: "attempt-native-empty",
      state: "succeeded",
      stopReason: null,
      generation: binding.generation,
      workspaceBinding: binding,
      publishedGeneration: binding.generation,
      works: [],
      cleanup: { status: "clean" },
      connectionReusable: true,
    });
    expect(
      attempts.adoptTerminalReceipt("attempt-native-empty", receipt),
    ).toEqual(receipt);
    await expect(cancellation).resolves.toEqual(receipt);
    expect(attempts.snapshot("attempt-native-empty")?.state).toBe("succeeded");
    attempts.releaseOwner("attempt-native-empty");
  });

  it("keeps an empty attempt pending while Native begin registration is unresolved", async () => {
    const attempts = controller();
    attempts.begin("attempt-registration-pending", binding);
    attempts.markNativeRegistrationPending("attempt-registration-pending");

    const cancellation = attempts.requestStop(
      "attempt-registration-pending",
      "closed",
    );
    let resolved = false;
    void cancellation.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(attempts.snapshot("attempt-registration-pending")?.state).toBe(
      "stop-requested",
    );

    attempts.markNativeOwned("attempt-registration-pending");
    const receipt = parseNarrativeMaintenanceTerminalReceipt({
      schemaVersion: 1,
      attemptId: "attempt-registration-pending",
      state: "interrupted",
      stopReason: "closed",
      generation: binding.generation,
      workspaceBinding: binding,
      publishedGeneration: null,
      works: [],
      cleanup: { status: "clean" },
      connectionReusable: true,
    });
    attempts.adoptTerminalReceipt("attempt-registration-pending", receipt);
    await expect(cancellation).resolves.toEqual(receipt);
  });

  it("rejects a local placeholder for a Native-owned attempt", () => {
    const attempts = controller();
    attempts.begin("attempt-native-placeholder", binding);
    attempts.markNativeOwned("attempt-native-placeholder");
    expect(() =>
      attempts.settle("attempt-native-placeholder", { state: "interrupted" }),
    ).toThrow(/Native-owned/);
  });

  it("evicts an adopted Native terminal record after its owner releases while preserving late waiters", async () => {
    const attempts = controller();
    attempts.begin("attempt-evict", binding);
    attempts.retainOwner("attempt-evict");
    attempts.markNativeOwned("attempt-evict");
    const receipt = parseNarrativeMaintenanceTerminalReceipt({
      schemaVersion: 1,
      attemptId: "attempt-evict",
      state: "succeeded",
      stopReason: null,
      generation: binding.generation,
      workspaceBinding: binding,
      publishedGeneration: binding.generation,
      works: [],
      cleanup: { status: "clean" },
      connectionReusable: true,
    });
    attempts.adoptTerminalReceipt("attempt-evict", receipt);
    expect(attempts.snapshot("attempt-evict")).not.toBeNull();

    attempts.releaseOwner("attempt-evict");
    expect(attempts.snapshot("attempt-evict")).toBeNull();
    await expect(attempts.waitForTerminal("attempt-evict")).resolves.toEqual(
      receipt,
    );
    expect(attempts.adoptTerminalReceipt("attempt-evict", receipt)).toBe(
      receipt,
    );
  });

  it("returns the exact cached receipt for a late same-id stop", async () => {
    const attempts = controller();
    attempts.begin("attempt-cached-stop", binding);
    attempts.retainOwner("attempt-cached-stop");
    attempts.markNativeOwned("attempt-cached-stop");
    const receipt = parseNarrativeMaintenanceTerminalReceipt({
      schemaVersion: 1,
      attemptId: "attempt-cached-stop",
      state: "interrupted",
      stopReason: "closed",
      generation: binding.generation,
      workspaceBinding: binding,
      publishedGeneration: null,
      works: [],
      cleanup: { status: "clean" },
      connectionReusable: true,
    });

    const firstStop = attempts.requestStop("attempt-cached-stop", "closed");
    attempts.adoptTerminalReceipt("attempt-cached-stop", receipt);
    attempts.releaseOwner("attempt-cached-stop");

    await expect(firstStop).resolves.toBe(receipt);
    await expect(
      attempts.requestStop("attempt-cached-stop", "closed"),
    ).resolves.toBe(receipt);
  });

  it("bounds local terminal records while preserving an admitted waiter", async () => {
    const attempts = controller();
    attempts.begin("attempt-admitted-waiter", binding);
    const admittedWaiter = attempts.waitForTerminal("attempt-admitted-waiter");
    const admittedReceipt = attempts.settle("attempt-admitted-waiter", {
      state: "interrupted",
    });
    await expect(admittedWaiter).resolves.toBe(admittedReceipt);

    for (
      let index = 0;
      index < NARRATIVE_MAINTENANCE_MAX_TERMINAL_RECEIPTS + 44;
      index += 1
    ) {
      const attemptId = `attempt-local-${index}`;
      attempts.begin(attemptId, binding);
      attempts.retainOwner(attemptId);
      attempts.settle(attemptId, { state: "interrupted" });
      attempts.releaseOwner(attemptId);
    }

    const newestId = `attempt-local-${NARRATIVE_MAINTENANCE_MAX_TERMINAL_RECEIPTS + 43}`;
    await expect(attempts.waitForTerminal(newestId)).resolves.toMatchObject({
      attemptId: newestId,
      state: "interrupted",
    });
    expect(() => attempts.waitForTerminal("attempt-local-0")).toThrow(
      /unknown maintenance attempt/,
    );
  });

  it("parses the Native state wire field and binds cleanup to the exact workspace", () => {
    const receipt = parseNarrativeMaintenanceTerminalReceipt(
      JSON.stringify({
        schemaVersion: 1,
        attemptId: "attempt-native",
        state: "interrupted",
        stopReason: "cancelled",
        generation: 7,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [{ workKey: "work-a", status: "interrupted" }],
        cleanup: { status: "clean" },
        connectionReusable: true,
      }),
    );
    expect(receipt.state).toBe("interrupted");
    expect(receipt.workspaceBinding).toEqual(binding);

    const attempts = controller();
    attempts.begin("attempt-native", binding);
    expect(() =>
      attempts.adoptTerminalReceipt("attempt-native", {
        ...receipt,
        workspaceBinding: { authorityId: "other", generation: 8 },
      }),
    ).toThrow(/binding mismatch/);
    expect(() =>
      parseNarrativeMaintenanceTerminalReceipt({
        ...receipt,
        cleanup: { status: "failed", error: "rollback" },
        connectionReusable: false,
      }),
    ).not.toThrow();
  });
});
