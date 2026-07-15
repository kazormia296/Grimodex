import { describe, expect, it, vi } from "vitest";
import { createMemoryWorkspaceStore } from "./indexedDbStore";
import { createPersistenceController } from "./persistenceController";

describe("browser workspace persistence controller", () => {
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
    await expect(first.flush()).rejects.toMatchObject({ code: "stale-write" });

    await expect(store.get("workspace-1")).resolves.toMatchObject({
      revision: 2,
      bytes: new Uint8Array([2]),
    });

    await first.restore();
    first.markDirty();
    await first.flush();
    await expect(store.get("workspace-1")).resolves.toMatchObject({
      revision: 3,
      bytes: new Uint8Array([3]),
    });
  });
});
