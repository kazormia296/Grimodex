import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
  canScheduleQuiescenceMutation,
  isAuthorityBlockingLifecycleIdle,
  isQuiescenceLeaseActive,
  subscribeQuiescenceLease,
} from "./quiescenceLease";
import { enqueueIpc, resetIpcQueueForTests } from "@/lib/ipcQueue";
import {
  advanceActiveLifecycleTransition,
  LIFECYCLE_TRACE_OPT_IN_KEY,
  subscribeLifecycleTrace,
  type LifecycleTraceEvent,
} from "./lifecycleTrace";

afterEach(() => {
  _resetQuiescenceLeasesForTests();
  resetIpcQueueForTests();
  Reflect.deleteProperty(globalThis, LIFECYCLE_TRACE_OPT_IN_KEY);
});

describe("quiescence lease", () => {
  it("creates the requested transition at Project/Workspace lease acquisition", () => {
    Object.assign(globalThis, {
      [LIFECYCLE_TRACE_OPT_IN_KEY]: true,
    });
    const events: LifecycleTraceEvent[] = [];
    const admissionAtMilestone: boolean[] = [];
    const unsubscribe = subscribeLifecycleTrace((event) => {
      events.push(event);
      if (event.phase === "quiescence-started") {
        admissionAtMilestone.push(canScheduleQuiescenceMutation());
      }
    });
    const lease = acquireQuiescenceLease("project-load", {
      transition: {
        kind: "project",
        from: {
          workspacePath: "/novel",
          workspaceOpenRevision: 5,
          projectId: "project-a",
        },
        to: {
          workspacePath: "/novel",
          workspaceOpenRevision: 5,
          projectId: "project-b",
        },
      },
    });

    try {
      expect(lease.transition).not.toBeNull();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        transitionId: lease.transition?.transitionId,
        phase: "switch-requested",
        kind: "project",
        from: { projectId: "project-a" },
        to: { projectId: "project-b" },
      });
      expect(events[1]).toMatchObject({
        transitionId: lease.transition?.transitionId,
        phase: "quiescence-started",
      });
      expect(admissionAtMilestone).toEqual([false]);
      expect(advanceActiveLifecycleTransition("old-stream-completed")).toBe(
        true,
      );
      expect(advanceActiveLifecycleTransition("old-scope-persisted")).toBe(
        true,
      );
    } finally {
      lease.release();
      expect(advanceActiveLifecycleTransition("old-stream-completed")).toBe(
        false,
      );
      unsubscribe();
    }
  });

  it("blocks rebuildable derived work for the full lifecycle lease", async () => {
    const lease = acquireQuiescenceLease("workspace-open");
    const derivedRun = vi.fn(async () => 1);

    await expect(
      enqueueIpc("semantic_reindex_all", derivedRun, null, "derived"),
    ).rejects.toThrow("IPC_DERIVED_CANCELLED");
    lease.openTargetReadPhase();
    await expect(
      enqueueIpc("semantic_index_scene", derivedRun, null, "derived"),
    ).rejects.toThrow("IPC_DERIVED_CANCELLED");
    expect(derivedRun).not.toHaveBeenCalled();

    lease.release();
    await expect(
      enqueueIpc("semantic_index_scene", derivedRun, null, "derived"),
    ).resolves.toBe(1);
  });

  it("starts a window-close lease with reads open until its controller seals", async () => {
    const lease = acquireQuiescenceLease("window-close");
    const readRun = vi.fn(async () => "persistence");

    expect(canScheduleQuiescenceMutation()).toBe(false);
    await expect(
      enqueueIpc("close-persistence-read", readRun, 10_000, "read"),
    ).resolves.toBe("persistence");

    lease.sealReadsForAuthorityCommit();
    await expect(
      enqueueIpc("read-after-close-commit", readRun, 10_000, "read"),
    ).rejects.toThrow("IPC_READ_CANCELLED");

    lease.release();
  });

  it("blocks read IPC until the final nested lifecycle lease releases", async () => {
    const workspaceLease = acquireQuiescenceLease("workspace-open");
    const projectLease = acquireQuiescenceLease("project-load");
    const readRun = vi.fn(async () => "new scope");

    await expect(
      enqueueIpc("old-scope-read", readRun, 10_000, "read"),
    ).rejects.toThrow("IPC_READ_CANCELLED");
    expect(readRun).not.toHaveBeenCalled();

    projectLease.release();
    await expect(
      enqueueIpc("still-blocked-read", readRun, 10_000, "read"),
    ).rejects.toThrow("IPC_READ_CANCELLED");
    expect(readRun).not.toHaveBeenCalled();

    workspaceLease.release();
    await expect(
      enqueueIpc("new-scope-read", readRun, 10_000, "read"),
    ).resolves.toBe("new scope");
    expect(readRun).toHaveBeenCalledOnce();
  });

  it.each(["project-load", "workspace-open", "window-close"] as const)(
    "rejects data deletion while %s is active",
    (reason) => {
      const lifecycleLease = acquireQuiescenceLease(reason);

      try {
        expect(() => acquireQuiescenceLease("data-delete")).toThrow(
          "Cannot clear data while another destructive lifecycle is active",
        );
      } finally {
        lifecycleLease.release();
      }

      expect(isQuiescenceLeaseActive()).toBe(false);
    },
  );

  it.each(["project-load", "workspace-open"] as const)(
    "rejects %s while data deletion is active",
    (reason) => {
      const dataDeleteLease = acquireQuiescenceLease("data-delete");

      try {
        expect(() => acquireQuiescenceLease(reason)).toThrow(
          `Cannot start ${reason} while data deletion is active`,
        );
      } finally {
        dataDeleteLease.release();
      }

      expect(isQuiescenceLeaseActive()).toBe(false);
    },
  );

  it("allows close to wait for an earlier data deletion", () => {
    const dataDeleteLease = acquireQuiescenceLease("data-delete");
    const closeLease = acquireQuiescenceLease("window-close");

    expect(isAuthorityBlockingLifecycleIdle()).toBe(false);
    dataDeleteLease.release();
    expect(isAuthorityBlockingLifecycleIdle()).toBe(true);
    closeLease.release();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("rejects every new lease after renderer teardown", () => {
    const closeLease = acquireQuiescenceLease("window-close");
    closeLease.release({ disposition: "renderer-teardown" });

    expect(() => acquireQuiescenceLease("data-delete")).toThrow(
      "Cannot start data-delete after renderer teardown",
    );
    expect(() => acquireQuiescenceLease("project-load")).toThrow(
      "Cannot start project-load after renderer teardown",
    );
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("allows a controlled target-read phase and seals it before authority commit", async () => {
    const lease = acquireQuiescenceLease("project-load");
    const targetRead = vi.fn(async () => "target");

    lease.openTargetReadPhase();
    await expect(
      enqueueIpc("target-prepare", targetRead, 10_000, "read"),
    ).resolves.toBe("target");

    let releaseActiveRead!: () => void;
    const activeRead = enqueueIpc(
      "target-read-before-commit",
      () =>
        new Promise<void>((resolve) => {
          releaseActiveRead = resolve;
        }),
      10_000,
      "read",
    );
    await Promise.resolve();
    lease.sealReadsForAuthorityCommit();
    await expect(activeRead).rejects.toThrow("IPC_READ_CANCELLED");
    await expect(
      enqueueIpc("late-old-scope-read", targetRead, 10_000, "read"),
    ).rejects.toThrow("IPC_READ_CANCELLED");

    releaseActiveRead();
    await Promise.resolve();
    lease.openTargetReadPhase();
    await expect(
      enqueueIpc("published-target-read", targetRead, 10_000, "read"),
    ).resolves.toBe("target");
    lease.release();
  });

  it("does not let a superseded Project lease block or re-seal the latest target reads", async () => {
    const staleLease = acquireQuiescenceLease("project-load");
    staleLease.sealReadsForAuthorityCommit();

    const latestLease = acquireQuiescenceLease("project-load");
    latestLease.openTargetReadPhase();
    const targetRead = vi.fn(async () => "latest-target");

    await expect(
      enqueueIpc("latest-target-prepare", targetRead, 10_000, "read"),
    ).resolves.toBe("latest-target");

    staleLease.sealReadsForAuthorityCommit();
    await expect(
      enqueueIpc("latest-target-after-stale-seal", targetRead, 10_000, "read"),
    ).resolves.toBe("latest-target");

    latestLease.sealReadsForAuthorityCommit();
    await expect(
      enqueueIpc("read-after-latest-commit-seal", targetRead, 10_000, "read"),
    ).rejects.toThrow("IPC_READ_CANCELLED");

    staleLease.release();
    expect(canScheduleQuiescenceMutation()).toBe(false);
    latestLease.release();
    expect(canScheduleQuiescenceMutation()).toBe(true);
  });

  it("blocks new mutation scheduling until every lifecycle holder releases", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeQuiescenceLease(listener);
    const projectLease = acquireQuiescenceLease("project-load");
    const workspaceLease = acquireQuiescenceLease("workspace-open");

    expect(isQuiescenceLeaseActive()).toBe(true);
    expect(canScheduleQuiescenceMutation()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    projectLease.release();
    expect(isQuiescenceLeaseActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    workspaceLease.release();
    expect(isQuiescenceLeaseActive()).toBe(false);
    expect(canScheduleQuiescenceMutation()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);

    // A duplicated finally/cleanup path must not underflow the shared barrier.
    workspaceLease.release();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
