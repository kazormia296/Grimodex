import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloseQuiescenceController } from "./closeQuiescenceController";
import {
  acquireQuiescenceLease,
  _resetQuiescenceLeasesForTests,
  canScheduleQuiescenceMutation,
  isQuiescenceLeaseActive,
  isRendererTeardownStarted,
  subscribeQuiescenceLease,
} from "./quiescenceLease";
import {
  createAutoSave,
  registerAutoSaveForQuiesce,
} from "@/hooks/useAutoSave";
import { flushStrictQuiescence } from "./quiescenceCoordinator";
import { enqueueIpc, resetIpcQueueForTests } from "@/lib/ipcQueue";
import {
  _resetTimelapseGenesisBarriersForTests,
  beginTimelapseGenesisBarrier,
} from "@/features/timelapse/genesisBarrier";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";

afterEach(() => {
  _resetQuiescenceLeasesForTests();
  _resetTimelapseGenesisBarriersForTests();
  publishCurrentProjectId(null);
  resetIpcQueueForTests();
});

describe("createCloseQuiescenceController", () => {
  it("cancels a slow-genesis prelude without leaking mutation admission or a late lease", async () => {
    publishCurrentProjectId("project-slow");
    const genesis = beginTimelapseGenesisBarrier("project-slow");
    const close = vi.fn(async () => {});
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn(async () => {}),
      close,
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });
    expect(canScheduleQuiescenceMutation()).toBe(false);
    expect(isQuiescenceLeaseActive()).toBe(false);

    controller.cancel();
    await vi.waitFor(() => expect(canScheduleQuiescenceMutation()).toBe(true));
    genesis.complete();
    await Promise.resolve();
    await Promise.resolve();

    expect(isQuiescenceLeaseActive()).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("labels a successful native close as renderer teardown", async () => {
    const changes: Array<{
      active: boolean;
      releaseDisposition?: string;
    }> = [];
    const unsubscribe = subscribeQuiescenceLease((change) => {
      changes.push(change);
    });
    const close = vi.fn(async () => {});
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn(async () => {}),
      close,
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(changes.at(-1)).toMatchObject({
      active: false,
      releaseDisposition: "renderer-teardown",
    });
    expect(isRendererTeardownStarted()).toBe(true);
    expect(canScheduleQuiescenceMutation()).toBe(false);
    unsubscribe();
  });

  it("keeps the teardown disposition when the page unmounts during native close", async () => {
    const changes: Array<{
      active: boolean;
      releaseDisposition?: string;
    }> = [];
    const unsubscribe = subscribeQuiescenceLease((change) => {
      changes.push(change);
    });
    const close = vi.fn(() => new Promise<void>(() => {}));
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn(async () => {}),
      close,
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    controller.cancel();

    expect(changes.at(-1)).toMatchObject({
      active: false,
      releaseDisposition: "renderer-teardown",
    });
    unsubscribe();
  });

  it("flushes a debounced AutoSave and waits for its real write before closing", async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = vi.fn(() => saveGate);
    const autoSave = createAutoSave(save, 2_000);
    const unregister = registerAutoSaveForQuiesce(autoSave);
    const close = vi.fn(async () => {});
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: flushStrictQuiescence,
      close,
      onFailure: vi.fn(),
    });

    try {
      expect(autoSave.schedule()).toBe(true);
      controller.handleCloseRequest({ preventDefault: vi.fn() });
      await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
      expect(close).not.toHaveBeenCalled();

      releaseSave();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(isQuiescenceLeaseActive()).toBe(false);
    } finally {
      autoSave.cancel();
      unregister();
    }
  });

  it("synchronously vetoes, waits for flush, then lets the second close pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const secondPrevent = vi.fn();
    const close = vi.fn(async () => {
      controller.handleCloseRequest({ preventDefault: secondPrevent });
    });
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: () => gate,
      close,
      onFailure: vi.fn(),
    });
    const firstPrevent = vi.fn();

    controller.handleCloseRequest({ preventDefault: firstPrevent });
    expect(firstPrevent).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(canScheduleQuiescenceMutation()).toBe(false);
    await vi.waitFor(() => expect(isQuiescenceLeaseActive()).toBe(true));

    release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(secondPrevent).not.toHaveBeenCalled();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("waits for a Workspace lifecycle and its nested Project load without deadlock", async () => {
    const workspaceLease = acquireQuiescenceLease("workspace-open");
    const flush = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush,
      close,
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();

    // A same-path Workspace reopen can start its nested Project load after the
    // close request began. It must be allowed to finish, not blocked by the
    // close holder or omitted from the wait set.
    const projectLease = acquireQuiescenceLease("project-load");
    workspaceLease.release();
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();

    projectLease.release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(flush).toHaveBeenCalledOnce();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("does not block target reads needed by a Workspace lifecycle it is waiting for", async () => {
    const workspaceLease = acquireQuiescenceLease("workspace-open");
    workspaceLease.openTargetReadPhase();
    const flush = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush,
      close,
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();

    const hydrateRead = vi.fn(async () => "hydrated");
    await expect(
      enqueueIpc("workspace-target-read", hydrateRead, 10_000, "read"),
    ).resolves.toBe("hydrated");
    expect(hydrateRead).toHaveBeenCalledOnce();

    workspaceLease.release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(flush).toHaveBeenCalledOnce();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("seals read admission immediately before the native close", async () => {
    const lateRead = vi.fn(async () => "too late");
    const close = vi.fn(async () => {
      await expect(
        enqueueIpc("read-during-close", lateRead, 10_000, "read"),
      ).rejects.toThrow("IPC_READ_CANCELLED");
    });
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn(async () => {}),
      close,
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(lateRead).not.toHaveBeenCalled();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("does not wait on its own or another window-close lease", async () => {
    const otherWindowLease = acquireQuiescenceLease("window-close");
    const flush = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush,
      close,
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(flush).toHaveBeenCalledOnce();
    // The controller released its own holder; the other window still owns one.
    expect(isQuiescenceLeaseActive()).toBe(true);
    otherWindowLease.release();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it.each(["project-load", "workspace-open"] as const)(
    "includes %s scheduled immediately after the close request",
    async (reason) => {
      const flush = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const controller = createCloseQuiescenceController({
        hasImmediateVeto: () => false,
        flush,
        close,
        onFailure: vi.fn(),
      });

      controller.handleCloseRequest({ preventDefault: vi.fn() });
      const lifecycleLease = acquireQuiescenceLease(reason);
      await Promise.resolve();
      expect(flush).not.toHaveBeenCalled();

      lifecycleLease.release();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(flush).toHaveBeenCalledOnce();
      expect(isQuiescenceLeaseActive()).toBe(false);
    },
  );

  it.each(["project-load", "workspace-open"] as const)(
    "waits again when %s starts while close flush is running",
    async (reason) => {
      let releaseFlush!: () => void;
      const flushGate = new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
      const flush = vi.fn(() => flushGate);
      const close = vi.fn(async () => {});
      const controller = createCloseQuiescenceController({
        hasImmediateVeto: () => false,
        flush,
        close,
        onFailure: vi.fn(),
      });

      controller.handleCloseRequest({ preventDefault: vi.fn() });
      await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
      const lifecycleLease = acquireQuiescenceLease(reason);

      releaseFlush();
      await Promise.resolve();
      await Promise.resolve();
      expect(close).not.toHaveBeenCalled();

      lifecycleLease.release();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(isQuiescenceLeaseActive()).toBe(false);
    },
  );

  it("waits for data deletion that began before the close request", async () => {
    const dataDeleteLease = acquireQuiescenceLease("data-delete");
    const flush = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush,
      close,
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    dataDeleteLease.release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(flush).toHaveBeenCalledOnce();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("cancels safely while waiting for a Workspace lifecycle", async () => {
    const workspaceLease = acquireQuiescenceLease("workspace-open");
    const flush = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush,
      close,
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });
    await Promise.resolve();
    controller.cancel();
    workspaceLease.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(flush).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("keeps the window open and exposes retry after a failed flush", async () => {
    const failure = vi.fn();
    const close = vi.fn(async () => {});
    const flush = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush,
      close,
      onFailure: failure,
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    expect(canScheduleQuiescenceMutation()).toBe(false);

    controller.retry();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("reopens read admission when retrying after a failed native close", async () => {
    const failure = vi.fn();
    const persistenceRead = vi.fn(async () => "current");
    const flush = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        await enqueueIpc(
          "retry-persistence-read",
          persistenceRead,
          10_000,
          "read",
        );
      });
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("native close failed"))
      .mockResolvedValueOnce(undefined);
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush,
      close,
      onFailure: failure,
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());

    controller.retry();

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(persistenceRead).toHaveBeenCalledOnce();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("releases a failed close lease when the user cancels", async () => {
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn().mockRejectedValue(new Error("disk full")),
      close: vi.fn(async () => {}),
      onFailure: vi.fn(),
    });

    controller.handleCloseRequest({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(isQuiescenceLeaseActive()).toBe(true));

    controller.cancel();

    expect(isQuiescenceLeaseActive()).toBe(false);
    expect(canScheduleQuiescenceMutation()).toBe(true);
  });

  it("holds the lease through explicit discard and releases after close", async () => {
    let release!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => closeGate);
    const onFailure = vi.fn();
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn().mockRejectedValue(new Error("disk full")),
      close,
      onFailure,
    });
    controller.handleCloseRequest({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
    expect(isQuiescenceLeaseActive()).toBe(true);

    const workspaceLease = acquireQuiescenceLease("workspace-open");
    controller.discardAndClose();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    workspaceLease.release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(isQuiescenceLeaseActive()).toBe(true);

    release();
    await vi.waitFor(() => expect(isQuiescenceLeaseActive()).toBe(false));
  });
});
