import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNarrativeMaintenanceTriggerCoordinator,
} from "./narrativeMaintenanceTriggers.js";
import type {
  NarrativeMaintenanceRequest,
  NarrativeMaintenanceScheduler,
} from "./narrativeMaintenance.js";

function makeScheduler() {
  return {
    requestManyWithBinding: vi.fn(),
  } as unknown as NarrativeMaintenanceScheduler & {
    requestManyWithBinding: ReturnType<typeof vi.fn>;
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function page(work: readonly Record<string, unknown>[]) {
  return { work };
}

function discovery(
  authorityId: string,
  generation: number,
  pages: readonly Record<string, unknown>[][],
) {
  return {
    workspaceBinding: { authorityId, generation },
    pages: pages.map((work) => page(work)),
  };
}

function backfill(projectId: string, reason = "workspace-opened") {
  return {
    projectId,
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v3",
    semanticEpochId: null,
    reasons: [reason],
  };
}

describe("narrative maintenance trigger coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("discovers workspace-wide work from workspace:opened and enqueues the returned binding", async () => {
    const scheduler = makeScheduler();
    const discoverNarrativeMaintenanceWork = vi.fn().mockResolvedValue(
      discovery("authority-open", 4, [[backfill("project-1")]]),
    );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", {
      path: "/renderer-must-not-be-used",
    });
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
      "workspace-opened",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [
        {
          projectId: "project-1",
          runKind: "backfill",
          workKey: "legacy-dependency-backfill:v3",
          semanticEpochId: null,
          reason: "workspace-opened",
        },
      ],
      { authorityId: "authority-open", generation: 4 },
    );
    expect(discoverNarrativeMaintenanceWork.mock.calls[0]).not.toContain(
      "/renderer-must-not-be-used",
    );
    coordinator.dispose();
  });

  it("maps the existing restore workspace:opened reason to RestoreCompleted without forwarding its path", async () => {
    const scheduler = makeScheduler();
    const discoverNarrativeMaintenanceWork = vi.fn().mockResolvedValue(
      discovery("authority-restore", 8, [
        [
          {
            projectId: "project-1",
            runKind: "dependency-verify",
            workKey: "dependency-verify:epoch-8",
            semanticEpochId: "epoch-8",
            reasons: ["restore-completed"],
          },
        ],
      ]),
    );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", {
      path: "/must-not-cross-the-boundary",
      reason: "restore",
    });
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
      "restore-completed",
    );
    expect(discoverNarrativeMaintenanceWork.mock.calls[0]).not.toContain(
      "/must-not-cross-the-boundary",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ reason: "restore-completed" })],
      { authorityId: "authority-restore", generation: 8 },
    );
    coordinator.dispose();
  });

  it("collects more than one bounded page in one pinned discovery call", async () => {
    const scheduler = makeScheduler();
    const firstPage = Array.from({ length: 32 }, (_, index) =>
      backfill(`project-${index}`),
    );
    const secondPage = [backfill("project-32")];
    const discoverNarrativeMaintenanceWork = vi.fn().mockResolvedValue(
      discovery("authority-many", 2, [firstPage, secondPage]),
    );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledOnce();
    const [work, binding] = scheduler.requestManyWithBinding.mock.calls[0] as [
      readonly NarrativeMaintenanceRequest[],
      unknown,
    ];
    expect(work).toHaveLength(33);
    expect(binding).toEqual({ authorityId: "authority-many", generation: 2 });
    coordinator.dispose();
  });

  it("rejects a stale per-page binding instead of accepting an authority change mid-enumeration", async () => {
    const scheduler = makeScheduler();
    const warn = vi.fn();
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      {
        discoverNarrativeMaintenanceWork: vi.fn().mockResolvedValue({
          workspaceBinding: { authorityId: "authority-pinned", generation: 3 },
          pages: [
            { work: [backfill("p1")] },
            {
              workspaceBinding: {
                authorityId: "authority-replaced",
                generation: 4,
              },
              work: [backfill("p2")],
            },
          ],
        }),
      },
      scheduler,
      { warn },
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runAllTimersAsync();

    expect(scheduler.requestManyWithBinding).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[narrative-maintenance] discovery failed:",
      expect.any(Error),
    );
    coordinator.dispose();
  });

  it("does not partially enqueue when a later page contains a renderer digest", async () => {
    const scheduler = makeScheduler();
    const warn = vi.fn();
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      {
        discoverNarrativeMaintenanceWork: vi.fn().mockResolvedValue(
          discovery("authority-digest", 1, [
            [backfill("p1")],
            [{ ...backfill("p2"), graphContractDigest: "renderer-forged" }],
          ]),
        ),
      },
      scheduler,
      { warn },
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runAllTimersAsync();

    expect(scheduler.requestManyWithBinding).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[narrative-maintenance] discovery failed:",
      expect.any(Error),
    );
    coordinator.dispose();
  });

  it("makes Repair unreachable at the main discovery boundary", async () => {
    const scheduler = makeScheduler();
    const warn = vi.fn();
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      {
        discoverNarrativeMaintenanceWork: vi.fn().mockResolvedValue(
          discovery("authority-repair", 1, [
            [
              {
                projectId: "p1",
                runKind: "repair",
                workKey: "repair",
                semanticEpochId: null,
                reasons: ["renderer-forged"],
              },
            ],
          ]),
        ),
      },
      scheduler,
      { warn },
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runAllTimersAsync();

    expect(scheduler.requestManyWithBinding).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    coordinator.dispose();
  });

  it("replaces an in-flight chain with the newest workspace event", async () => {
    const scheduler = makeScheduler();
    let resolveFirst!: (value: unknown) => void;
    const firstResponse = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(
        discovery("authority-restore", 5, [[backfill("restore-project", "restore-completed")]]),
      );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runOnlyPendingTimersAsync();
    coordinator.handleBackendEvent("workspace:opened", { reason: "restore" });
    resolveFirst(discovery("authority-open", 4, [[backfill("open-project")]]));
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      1,
      "workspace-opened",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      2,
      "restore-completed",
    );
    // The first authority result is stale once the replacement event advances
    // the chain generation; only the replacement discovery may enqueue.
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledTimes(1);
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      expect.anything(),
      { authorityId: "authority-restore", generation: 5 },
    );
    coordinator.dispose();
  });

  it("replaces a pending restore follow-up when a new ordinary open arrives", async () => {
    const scheduler = makeScheduler();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockResolvedValueOnce(
        discovery("authority-restore", 5, [[backfill("restore-project", "restore-completed")]]),
      )
      .mockResolvedValueOnce(
        discovery("authority-open", 6, [[backfill("ordinary-project")]]),
      );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", { reason: "restore" });
    await vi.runAllTimersAsync();
    coordinator.requestRediscovery();
    await vi.advanceTimersByTimeAsync(100);
    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      1,
      "restore-completed",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      2,
      "workspace-opened",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledTimes(2);
    expect(scheduler.requestManyWithBinding).toHaveBeenLastCalledWith(
      [expect.objectContaining({ projectId: "ordinary-project", reason: "workspace-opened" })],
      { authorityId: "authority-open", generation: 6 },
    );
    coordinator.dispose();
  });

  it("does not enqueue or mutate the new chain from an old in-flight discovery", async () => {
    const scheduler = makeScheduler();
    let resolveOld!: (value: unknown) => void;
    const oldDiscovery = new Promise<unknown>((resolve) => {
      resolveOld = resolve;
    });
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockReturnValueOnce(oldDiscovery)
      .mockResolvedValueOnce(
        discovery("authority-new", 9, [[backfill("new-project")]]),
      );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", { reason: "restore" });
    await vi.runOnlyPendingTimersAsync();
    coordinator.handleBackendEvent("workspace:opened", {});
    resolveOld(
      discovery("authority-old", 8, [[backfill("old-project", "restore-completed")]]),
    );
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      1,
      "restore-completed",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      2,
      "workspace-opened",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledTimes(1);
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "new-project" })],
      { authorityId: "authority-new", generation: 9 },
    );
    expect(scheduler.requestManyWithBinding).not.toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "old-project" })],
      expect.anything(),
    );
    coordinator.dispose();
  });

  it("wakes on the trusted in-session semantic epoch rotation event", async () => {
    const scheduler = makeScheduler();
    const discoverNarrativeMaintenanceWork = vi.fn().mockResolvedValue(
      discovery("authority-live", 10, [[backfill("rotated-project", "semantic-epoch-rotated")]]),
    );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => ({
          authorityId: "authority-live",
          generation: 10,
        }),
        discoverNarrativeMaintenanceWork,
      },
      scheduler,
    );

    coordinator.handleBackendEvent("narrative-maintenance:epoch-rotated", {
      projectId: "rotated-project",
      authorityId: "authority-live",
      generation: 10,
    });
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
      "semantic-epoch-rotated",
    );
    coordinator.dispose();
  });

  it("ignores a late A epoch event while B workspace-opened discovery is in flight", async () => {
    const scheduler = makeScheduler();
    const currentBinding = { authorityId: "authority-b", generation: 2 };
    const bDiscovery = deferred<unknown>();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockReturnValueOnce(bDiscovery.promise);
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
        discoverNarrativeMaintenanceWork,
      },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runOnlyPendingTimersAsync();
    coordinator.handleBackendEvent("narrative-maintenance:epoch-rotated", {
      projectId: "project-a",
      operation: "integrity-repair",
      reason: "semantic-epoch-rotated",
      authorityId: "authority-a",
      generation: 1,
    });
    bDiscovery.resolve(
      discovery("authority-b", 2, [[backfill("project-b")]]),
    );
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();
    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
      "workspace-opened",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledOnce();
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "project-b" })],
      currentBinding,
    );
    coordinator.dispose();
  });

  it("clears a completed restore chain before the next ordinary open", async () => {
    const scheduler = makeScheduler();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockResolvedValueOnce(discovery("authority-restore", 5, []))
      .mockResolvedValueOnce(
        discovery("authority-open", 6, [[backfill("ordinary-project")]]),
      );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", { reason: "restore" });
    await vi.runAllTimersAsync();
    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      1,
      "restore-completed",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      2,
      "workspace-opened",
    );
    coordinator.dispose();
  });

  it("ACKs a durable wake only after its discovery is validated and registered", async () => {
    const scheduler = makeScheduler();
    const binding = { authorityId: "authority-outbox", generation: 7 };
    const pendingDiscovery = deferred<unknown>();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockReturnValue(pendingDiscovery.promise);
    const ackNarrativeMaintenanceWakeOutbox = vi
      .fn()
      .mockResolvedValue({ status: "accepted", acknowledged: 1 });
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        listNarrativeMaintenanceWakeOutbox: vi.fn().mockResolvedValue([
          { id: "wake-1" },
        ]),
        ackNarrativeMaintenanceWakeOutbox,
        discoverNarrativeMaintenanceWork,
      },
      scheduler,
    );

    await coordinator.drainWakeOutbox();
    await vi.runOnlyPendingTimersAsync();
    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
      "semantic-epoch-rotated",
    );
    expect(ackNarrativeMaintenanceWakeOutbox).not.toHaveBeenCalled();

    pendingDiscovery.resolve(discovery("authority-outbox", 7, [[backfill("p1")]]));
    await vi.runAllTimersAsync();

    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "p1" })],
      binding,
    );
    expect(ackNarrativeMaintenanceWakeOutbox).toHaveBeenCalledWith(
      ["wake-1"],
      binding,
    );
    coordinator.dispose();
  });

  it("leaves a durable wake pending when its discovery cannot be validated", async () => {
    const scheduler = makeScheduler();
    const binding = { authorityId: "authority-outbox", generation: 7 };
    const ackNarrativeMaintenanceWakeOutbox = vi.fn();
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => binding,
        listNarrativeMaintenanceWakeOutbox: vi.fn().mockResolvedValue([
          { id: "wake-1" },
        ]),
        ackNarrativeMaintenanceWakeOutbox,
        discoverNarrativeMaintenanceWork: vi.fn().mockResolvedValue(
          discovery("replacement-authority", 8, [[backfill("p1")]]),
        ),
      },
      scheduler,
      { warn: vi.fn() },
    );

    await coordinator.drainWakeOutbox();
    await vi.runAllTimersAsync();

    expect(scheduler.requestManyWithBinding).not.toHaveBeenCalled();
    expect(ackNarrativeMaintenanceWakeOutbox).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("bounds an unchanged non-empty planner result instead of spinning forever", async () => {
    const scheduler = makeScheduler();
    const response = discovery("authority-stale", 1, [[backfill("p1")]]);
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockResolvedValue(response);
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
      { warn: vi.fn() },
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runAllTimersAsync();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      coordinator.requestRediscovery();
      await vi.runAllTimersAsync();
    }

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledTimes(4);
    coordinator.dispose();
  });

  it("bounds unavailable and generic discovery failures without consuming work retry state", async () => {
    const scheduler = makeScheduler();
    const warn = vi.fn();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockRejectedValue(new Error("temporary discovery failure"));
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
      { warn },
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledTimes(4);
    expect(scheduler.requestManyWithBinding).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
