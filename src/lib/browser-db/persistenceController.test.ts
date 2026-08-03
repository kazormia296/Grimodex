import { describe, expect, it, vi } from "vitest";
import {
  computeAiAuditJournalBatchId,
  createMemoryWorkspaceStore,
} from "./indexedDbStore";
import { createPersistenceController } from "./persistenceController";

describe("browser workspace persistence controller", () => {
  const journalBatch = async (eventId: string) => {
    const appendArgsJson = JSON.stringify({
      expectedWorkspacePath: "/dev/workspace",
      projectId: "default-project",
      events: [{ eventId }],
    });
    return {
      batchId: await computeAiAuditJournalBatchId(appendArgsJson),
      appendArgsJson,
    };
  };

  it("keeps an AI audit durability ACK pending until the journal commits", async () => {
    const store = createMemoryWorkspaceStore();
    const originalAppend = store.appendAiAuditJournal.bind(store);
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    store.appendAiAuditJournal = vi.fn(async (input) => {
      markAppendStarted();
      await appendGate;
      return originalAppend(input);
    });
    const exportDatabase = vi.fn(async () => new Uint8Array([7]));
    const controller = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase,
    });
    controller.markDirty();
    let acknowledged = false;
    const journalAck = controller
      .acknowledgeAiAuditBatch(await journalBatch("audit-1"))
      .then(() => {
        acknowledged = true;
      });

    await appendStarted;
    expect(acknowledged).toBe(false);
    expect(exportDatabase).not.toHaveBeenCalled();
    releaseAppend();
    await journalAck;

    expect(acknowledged).toBe(true);
    await expect(store.readAiAuditJournal("workspace-1")).resolves.toEqual([
      expect.objectContaining({ sequence: 1 }),
    ]);
  });

  it("journals many partial batches without exporting or putting a full snapshot per partial", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryWorkspaceStore();
      const put = vi.spyOn(store, "put");
      const exportDatabase = vi.fn(async () => new Uint8Array([7]));
      const controller = createPersistenceController({
        store,
        workspaceId: "workspace-1",
        exportDatabase,
        debounceMs: 2_000,
      });

      for (let index = 0; index < 128; index += 1) {
        controller.markDirty();
        await controller.acknowledgeAiAuditBatch(
          await journalBatch(`partial-${index}`),
        );
      }

      expect(exportDatabase).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      await expect(
        store.readAiAuditJournal("workspace-1"),
      ).resolves.toHaveLength(128);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("compacts only the journal high-water captured before snapshot export", async () => {
    const store = createMemoryWorkspaceStore();
    let releaseExport!: () => void;
    let markExportStarted!: () => void;
    const exportGate = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    const exportStarted = new Promise<void>((resolve) => {
      markExportStarted = resolve;
    });
    const controller = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase: async () => {
        markExportStarted();
        await exportGate;
        return new Uint8Array([1]);
      },
    });
    await controller.acknowledgeAiAuditBatch(
      await journalBatch("before-export"),
    );
    controller.markDirty();

    const flush = controller.flush();
    await exportStarted;
    await store.appendAiAuditJournal({
      workspaceId: "workspace-1",
      expectedRevision: 0,
      createdAt: "2026-08-03T00:00:00.000Z",
      ...(await journalBatch("after-export")),
    });
    releaseExport();
    await flush;

    await expect(store.get("workspace-1")).resolves.toMatchObject({
      revision: 1,
      bytes: new Uint8Array([1]),
    });
    await expect(store.readAiAuditJournal("workspace-1")).resolves.toEqual([
      expect.objectContaining({ sequence: 2 }),
    ]);
  });

  it("does not export another full snapshot after the outstanding journal is compacted", async () => {
    const store = createMemoryWorkspaceStore();
    const put = vi.spyOn(store, "put");
    const exportDatabase = vi.fn(async () => new Uint8Array([1]));
    const controller = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase,
    });
    await controller.acknowledgeAiAuditBatch(
      await journalBatch("compact-once"),
    );
    controller.markDirty();

    await controller.flush();
    expect(exportDatabase).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    await expect(store.readAiAuditJournal("workspace-1")).resolves.toEqual([]);

    await controller.flush();
    expect(exportDatabase).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
  });

  it("debounces dirty snapshots and flushes the newest export", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryWorkspaceStore();
      let value = 1;
      const controller = createPersistenceController({
        store,
        workspaceId: "workspace-1",
        exportDatabase: async () => new Uint8Array([value]),
        debounceMs: 20,
      });

      controller.markDirty();
      value = 2;
      vi.advanceTimersByTime(19);
      await expect(store.get("workspace-1")).resolves.toBeUndefined();
      vi.advanceTimersByTime(1);
      await controller.whenIdle();

      await expect(store.get("workspace-1")).resolves.toMatchObject({
        revision: 1,
        bytes: new Uint8Array([2]),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes concurrent flushes and advances revisions", async () => {
    const store = createMemoryWorkspaceStore();
    let value = 1;
    const controller = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase: async () => {
        const snapshot = value;
        await Promise.resolve();
        return new Uint8Array([snapshot]);
      },
      debounceMs: 0,
    });

    controller.markDirty();
    const first = controller.flush();
    await Promise.resolve();
    value = 2;
    controller.markDirty();
    const second = controller.flush();
    await Promise.all([first, second, controller.whenIdle()]);

    await expect(store.get("workspace-1")).resolves.toMatchObject({
      revision: 2,
      bytes: new Uint8Array([2]),
    });
  });

  it("flushes on an explicit lifecycle callback", async () => {
    const store = createMemoryWorkspaceStore();
    const controller = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase: async () => new Uint8Array([9]),
      debounceMs: 10_000,
    });

    controller.markDirty();
    await controller.flush();

    await expect(store.get("workspace-1")).resolves.toMatchObject({
      bytes: new Uint8Array([9]),
    });
  });

  it("stops on a stale write instead of overwriting another tab", async () => {
    const store = createMemoryWorkspaceStore();
    let firstValue = 1;
    const secondValue = 2;
    const first = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase: async () => new Uint8Array([firstValue]),
    });
    const second = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase: async () => new Uint8Array([secondValue]),
    });

    first.markDirty();
    await first.flush();
    await second.restore();
    second.markDirty();
    await second.flush();
    firstValue = 3;
    first.markDirty();
    const staleFailure = await first.flush().catch((error: unknown) => error);
    expect(staleFailure).toMatchObject({ code: "stale-write" });
    expect(first.isBlockedByConflict()).toBe(true);

    // An idempotent audit retry can have no new SQL mutation. Its journal ACK
    // must still reject the retained conflict instead of returning success.
    await expect(
      first.acknowledgeAiAuditBatch(await journalBatch("stale-audit")),
    ).rejects.toBe(staleFailure);

    await expect(store.get("workspace-1")).resolves.toMatchObject({
      revision: 2,
      bytes: new Uint8Array([2]),
    });

    await first.restore();
    expect(first.isBlockedByConflict()).toBe(false);
    first.markDirty();
    await first.flush();
    await expect(store.get("workspace-1")).resolves.toMatchObject({
      revision: 3,
      bytes: new Uint8Array([3]),
    });
  });

  it("does not let an open controller resurrect a deleted workspace", async () => {
    const store = createMemoryWorkspaceStore();
    await store.put({
      workspaceId: "workspace-1",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([1]),
    });
    const controller = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase: async () => new Uint8Array([2]),
    });
    await controller.restore();

    await store.delete("workspace-1");
    controller.markDirty();

    await expect(controller.flush()).rejects.toMatchObject({
      code: "stale-write",
    });
    expect(controller.isBlockedByConflict()).toBe(true);
    await expect(store.get("workspace-1")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("allows a new controller to recreate a deliberately deleted workspace", async () => {
    const store = createMemoryWorkspaceStore();
    await store.put({
      workspaceId: "workspace-1",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([1]),
    });
    await store.delete("workspace-1");
    const replacement = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase: async () => new Uint8Array([3]),
    });

    await expect(replacement.restore()).resolves.toBeUndefined();
    replacement.markDirty();
    await replacement.flush();

    await expect(store.get("workspace-1")).resolves.toMatchObject({
      revision: 3,
      bytes: new Uint8Array([3]),
    });
  });

  it("does not let an open controller recreate the old name after rename", async () => {
    const store = createMemoryWorkspaceStore();
    await store.put({
      workspaceId: "workspace-1",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([1]),
    });
    const controller = createPersistenceController({
      store,
      workspaceId: "workspace-1",
      exportDatabase: async () => new Uint8Array([2]),
    });
    await controller.restore();

    await store.rename("workspace-1", "workspace-renamed");
    controller.markDirty();

    await expect(controller.flush()).rejects.toMatchObject({
      code: "stale-write",
    });
    await expect(store.get("workspace-1")).resolves.toBeUndefined();
    await expect(store.get("workspace-renamed")).resolves.toMatchObject({
      revision: 1,
      bytes: new Uint8Array([1]),
    });
  });
});
