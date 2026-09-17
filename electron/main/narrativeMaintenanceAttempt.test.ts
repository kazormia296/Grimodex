import { describe, expect, it } from "vitest";

import {
  createNarrativeMaintenanceAttemptController,
  parseNarrativeMaintenanceTerminalReceipt,
  type NarrativeMaintenanceAttemptController,
} from "./narrativeMaintenanceAttempt.js";

const binding = { authorityId: "authority-a", generation: 7 };

function controller(): NarrativeMaintenanceAttemptController {
  return createNarrativeMaintenanceAttemptController();
}

describe("narrative maintenance attempt linearization", () => {
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

    attempts.begin("attempt-d", binding);
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
      /binding conflict/,
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
