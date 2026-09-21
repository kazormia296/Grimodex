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

  it("joins an in-flight discovery without registering work after disposal", async () => {
    const scheduler = makeScheduler();
    const pendingDiscovery = deferred<unknown>();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockReturnValue(pendingDiscovery.promise);
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.runOnlyPendingTimersAsync();
    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();

    const disposal = Promise.resolve(coordinator.dispose());
    let settled = false;
    void disposal.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    pendingDiscovery.resolve(
      discovery("authority-after-dispose", 2, [[backfill("late-project")]]),
    );
    await disposal;

    expect(scheduler.requestManyWithBinding).not.toHaveBeenCalled();
  });

  it("routes an expected C2-ZC NOT_READY wake through BeforeCutover discovery", async () => {
    const scheduler = makeScheduler();
    const discoverNarrativeMaintenanceWork = vi.fn().mockResolvedValue(
      discovery("authority-cutover", 9, [
        [
          {
            projectId: "project-1",
            runKind: "dependency-verify",
            workKey: "dependency-verify:epoch-9",
            semanticEpochId: "epoch-9",
            reasons: ["before-cutover"],
          },
        ],
      ]),
    );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.requestBeforeCutoverPreparation();
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
      "before-cutover",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ reason: "before-cutover" })],
      { authorityId: "authority-cutover", generation: 9 },
    );
    coordinator.dispose();
  });

  it("coalesces repeated before-cutover wakes during slow discovery", async () => {
    const scheduler = makeScheduler();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000);
        });
        return discovery("authority-cutover", 9, [
          [
            {
              projectId: "cutover-project",
              runKind: "dependency-verify",
              workKey: "dependency-verify:epoch-9",
              semanticEpochId: "epoch-9",
              reasons: ["before-cutover"],
            },
          ],
        ]);
      });
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.requestBeforeCutoverPreparation();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.requestBeforeCutoverPreparation();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "cutover-project" })],
      { authorityId: "authority-cutover", generation: 9 },
    );
    coordinator.dispose();
  });

  it("does not replace a pending restore wake with repeated before-cutover", async () => {
    const scheduler = makeScheduler();
    const firstDiscovery = deferred<unknown>();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockReturnValueOnce(firstDiscovery.promise)
      .mockResolvedValueOnce(
        discovery("authority-restore", 8, [
          [backfill("restore-project", "restore-completed")],
        ]),
      );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", {});
    await vi.advanceTimersByTimeAsync(0);
    coordinator.handleBackendEvent("workspace:opened", { reason: "restore" });
    coordinator.requestBeforeCutoverPreparation();
    firstDiscovery.resolve(
      discovery("authority-open", 7, [[backfill("open-project")]]),
    );
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      1,
      "workspace-opened",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      2,
      "restore-completed",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "restore-project" })],
      { authorityId: "authority-restore", generation: 8 },
    );
    expect(scheduler.requestManyWithBinding).not.toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "open-project" })],
      expect.anything(),
    );
    coordinator.dispose();
  });

  it("does not replace an in-flight restore wake with before-cutover", async () => {
    const scheduler = makeScheduler();
    const restoreDiscovery = deferred<unknown>();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockReturnValue(restoreDiscovery.promise);
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.handleBackendEvent("workspace:opened", { reason: "restore" });
    await vi.advanceTimersByTimeAsync(0);
    coordinator.requestBeforeCutoverPreparation();
    restoreDiscovery.resolve(
      discovery("authority-restore", 8, [
        [backfill("restore-project", "restore-completed")],
      ]),
    );
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();
    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledWith(
      "restore-completed",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "restore-project" })],
      { authorityId: "authority-restore", generation: 8 },
    );
    coordinator.dispose();
  });

  it("keeps a distinct later backend wake authoritative over before-cutover", async () => {
    const scheduler = makeScheduler();
    const currentBinding = { authorityId: "authority-later", generation: 10 };
    const firstDiscovery = deferred<unknown>();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockReturnValueOnce(firstDiscovery.promise)
      .mockResolvedValueOnce(
        discovery("authority-later", 10, [[backfill("later-project")]]),
      );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
        discoverNarrativeMaintenanceWork,
      },
      scheduler,
    );

    coordinator.requestBeforeCutoverPreparation();
    await vi.advanceTimersByTimeAsync(0);
    coordinator.handleBackendEvent("narrative-maintenance:epoch-rotated", {
      authorityId: currentBinding.authorityId,
      generation: currentBinding.generation,
    });
    firstDiscovery.resolve(
      discovery("authority-before", 9, [
        [backfill("before-project", "before-cutover")],
      ]),
    );
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      1,
      "before-cutover",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      2,
      "semantic-epoch-rotated",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "later-project" })],
      { authorityId: "authority-later", generation: 10 },
    );
    expect(scheduler.requestManyWithBinding).not.toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "before-project" })],
      expect.anything(),
    );
    coordinator.dispose();
  });

  it("does not restart an exhausted before-cutover chain from a repeated NOT_READY", async () => {
    const scheduler = makeScheduler();
    const response = discovery("authority-stale", 1, [
      [backfill("stale-project", "before-cutover")],
    ]);
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockResolvedValue(response);
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.requestBeforeCutoverPreparation();
    await vi.runAllTimersAsync();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      coordinator.requestRediscovery();
      await vi.runAllTimersAsync();
    }

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledTimes(4);
    const exhaustedRevision =
      coordinator.getQuiescenceState?.().mutationRevision;
    coordinator.requestBeforeCutoverPreparation();
    expect(coordinator.getQuiescenceState?.().mutationRevision).toBe(
      exhaustedRevision,
    );
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledTimes(4);
    coordinator.dispose();
  });

  it("does not restart a settled non-empty before-cutover chain from the next poll", async () => {
    const scheduler = makeScheduler();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockResolvedValue(
        discovery("authority-cutover", 9, [
          [backfill("cutover-project", "before-cutover")],
        ]),
      );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.requestBeforeCutoverPreparation();
    await vi.runAllTimersAsync();
    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();
    const settledRevision = coordinator.getQuiescenceState?.().mutationRevision;
    coordinator.requestBeforeCutoverPreparation();
    expect(coordinator.getQuiescenceState?.().mutationRevision).toBe(
      settledRevision,
    );
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("ends an empty before-cutover chain so a later NOT_READY starts again", async () => {
    const scheduler = makeScheduler();
    const firstDiscovery = deferred<unknown>();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockReturnValueOnce(firstDiscovery.promise)
      .mockResolvedValueOnce(
        discovery("authority-next", 2, [
          [backfill("next-project", "before-cutover")],
        ]),
      );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.requestBeforeCutoverPreparation();
    await vi.advanceTimersByTimeAsync(0);
    coordinator.requestBeforeCutoverPreparation();
    firstDiscovery.resolve(discovery("authority-empty", 1, []));
    await vi.runAllTimersAsync();

    coordinator.requestBeforeCutoverPreparation();
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenCalledTimes(2);
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      1,
      "before-cutover",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      2,
      "before-cutover",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenCalledWith(
      [expect.objectContaining({ projectId: "next-project" })],
      { authorityId: "authority-next", generation: 2 },
    );
    coordinator.dispose();
  });

  it("allows before-cutover again after a distinct restore authority chain", async () => {
    const scheduler = makeScheduler();
    const discoverNarrativeMaintenanceWork = vi
      .fn()
      .mockResolvedValueOnce(
        discovery("authority-before", 1, [
          [backfill("before-project", "before-cutover")],
        ]),
      )
      .mockResolvedValueOnce(
        discovery("authority-restore", 2, [
          [backfill("restore-project", "restore-completed")],
        ]),
      )
      .mockResolvedValueOnce(
        discovery("authority-after", 3, [
          [backfill("after-project", "before-cutover")],
        ]),
      );
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      { discoverNarrativeMaintenanceWork },
      scheduler,
    );

    coordinator.requestBeforeCutoverPreparation();
    await vi.runAllTimersAsync();
    coordinator.handleBackendEvent("workspace:opened", { reason: "restore" });
    await vi.runAllTimersAsync();
    coordinator.requestBeforeCutoverPreparation();
    await vi.runAllTimersAsync();

    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      1,
      "before-cutover",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      2,
      "restore-completed",
    );
    expect(discoverNarrativeMaintenanceWork).toHaveBeenNthCalledWith(
      3,
      "before-cutover",
    );
    expect(scheduler.requestManyWithBinding).toHaveBeenLastCalledWith(
      [expect.objectContaining({ projectId: "after-project" })],
      { authorityId: "authority-after", generation: 3 },
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

  it("treats lifecycle transition as a deferred wake-outbox drain", async () => {
    const scheduler = makeScheduler();
    const warn = vi.fn();
    const coordinator = createNarrativeMaintenanceTriggerCoordinator(
      {
        getNarrativeMaintenanceWorkspaceBinding: () => ({
          authorityId: "authority-transition",
          generation: 4,
        }),
        listNarrativeMaintenanceWakeOutbox: vi
          .fn()
          .mockRejectedValueOnce(
            new Error("workspace lifecycle has active owners or unacknowledged work"),
          )
          .mockResolvedValueOnce([]),
        ackNarrativeMaintenanceWakeOutbox: vi.fn(),
        discoverNarrativeMaintenanceWork: vi.fn(),
      },
      scheduler,
      { warn },
    );

    await coordinator.drainWakeOutbox();

    expect(warn).not.toHaveBeenCalled();
    expect(coordinator.getQuiescenceState?.()).toMatchObject({
      wakeOutboxDrainFailed: false,
      wakeOutboxPendingRows: false,
    });

    await coordinator.drainWakeOutbox();
    expect(coordinator.getQuiescenceState?.()).toMatchObject({
      wakeOutboxDrainSucceeded: true,
      wakeOutboxDrainFailed: false,
    });
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
