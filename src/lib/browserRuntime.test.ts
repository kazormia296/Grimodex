import { describe, expect, it, vi } from "vitest";
import {
  BrowserWorkspaceError,
  createMemoryWorkspaceStore,
} from "./browser-db/indexedDbStore";
import {
  assertWebEditorDurability,
  browserPersistenceFailureMessage,
  BrowserWorkspaceLockError,
  createWebEditorWorkspaceStore,
  initializeBrowserRuntime,
  WEB_EDITOR_WORKSPACE_ID,
  type BrowserRuntimeDependencies,
} from "./browserRuntime";

function createExclusiveLockManager() {
  const held = new Set<string>();
  const request = vi.fn(
    async (
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ) => {
      if (options.ifAvailable && held.has(name)) {
        return await callback(null);
      }
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        held.delete(name);
      }
    },
  );
  return {
    held,
    request,
    lockManager: {
      request: request as unknown as LockManager["request"],
    },
  };
}

function createMockDatabase(bytes = new Uint8Array([9])) {
  return {
    exportDatabase: vi.fn(() => bytes),
    close: vi.fn(),
  };
}

function createDependencies(
  overrides: Partial<BrowserRuntimeDependencies> = {},
): BrowserRuntimeDependencies {
  return {
    createBrowserMock: vi.fn(async () => createMockDatabase()),
    installBrowserMock: vi.fn(),
    ...overrides,
  };
}

describe("Web Editor browser runtime", () => {
  it("fails closed when IndexedDB is unavailable", () => {
    expect(() => createWebEditorWorkspaceStore({ indexedDB: null })).toThrowError(
      expect.objectContaining<Partial<BrowserWorkspaceError>>({
        code: "unavailable",
      }),
    );
  });

  it("reports the default Web Editor store as persistent", () => {
    const indexedDB = { open: vi.fn() } as unknown as IDBFactory;

    const store = createWebEditorWorkspaceStore({ indexedDB });

    expect(store.getDurability()).toBe("persistent");
  });

  it("rejects an IndexedDB open failure before installing BrowserMock", async () => {
    const request = {} as IDBOpenDBRequest;
    const indexedDB = {
      open: vi.fn(() => {
        queueMicrotask(() => {
          Object.defineProperty(request, "error", {
            value: new DOMException("open failed", "UnknownError"),
          });
          request.onerror?.({} as Event);
        });
        return request;
      }),
    } as unknown as IDBFactory;
    const dependencies = createDependencies();
    const locks = createExclusiveLockManager();

    await expect(
      initializeBrowserRuntime({
        store: createWebEditorWorkspaceStore({ indexedDB }),
        lifecycleTarget: null,
        lockManager: locks.lockManager,
        dependencies,
      }),
    ).rejects.toMatchObject({
      name: "BrowserWorkspaceError",
      code: "storage-failed",
    });
    expect(locks.held.size).toBe(0);
    expect(dependencies.createBrowserMock).not.toHaveBeenCalled();
    expect(dependencies.installBrowserMock).not.toHaveBeenCalled();
  });

  it("rejects non-persistent durability at the Web Editor boundary", () => {
    expect(() => assertWebEditorDurability("memory")).toThrowError(
      expect.objectContaining<Partial<BrowserWorkspaceError>>({
        code: "unavailable",
      }),
    );
    expect(() => assertWebEditorDurability("persistent")).not.toThrow();
  });

  it("restores the workspace before installing BrowserMock", async () => {
    const store = createMemoryWorkspaceStore();
    const restoredBytes = new Uint8Array([1, 2, 3]);
    await store.put({
      workspaceId: WEB_EDITOR_WORKSPACE_ID,
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-20T00:00:00.000Z",
      bytes: restoredBytes,
    });
    const mock = createMockDatabase(new Uint8Array([4, 5, 6]));
    let onDatabaseDirty: (() => void) | undefined;
    const dependencies = createDependencies({
      createBrowserMock: vi.fn(async (options) => {
        expect(options.databaseBytes).toEqual(restoredBytes);
        onDatabaseDirty = options.onDatabaseDirty;
        return mock;
      }),
    });
    const locks = createExclusiveLockManager();

    const runtime = await initializeBrowserRuntime({
      store,
      lifecycleTarget: null,
      lockManager: locks.lockManager,
      dependencies,
    });

    expect(dependencies.installBrowserMock).toHaveBeenCalledWith(mock);
    onDatabaseDirty?.();
    await runtime.persistence.flush();
    await expect(store.get(WEB_EDITOR_WORKSPACE_ID)).resolves.toMatchObject({
      revision: 2,
      bytes: new Uint8Array([4, 5, 6]),
    });
    await runtime.dispose();
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it("flushes pending edits before exporting a desktop handoff snapshot", async () => {
    const store = createMemoryWorkspaceStore();
    const snapshot = new Uint8Array([83, 81, 76, 105, 116, 101]);
    const mock = createMockDatabase(snapshot);
    let markDirty: (() => void) | undefined;
    const dependencies = createDependencies({
      createBrowserMock: vi.fn(async (options) => {
        markDirty = options.onDatabaseDirty;
        return mock;
      }),
    });
    const runtime = await initializeBrowserRuntime({
      store,
      lifecycleTarget: null,
      lockManager: createExclusiveLockManager().lockManager,
      dependencies,
    });

    markDirty?.();
    await expect(runtime.exportWorkspace()).resolves.toEqual(snapshot);
    await expect(store.get(WEB_EDITOR_WORKSPACE_ID)).resolves.toMatchObject({
      revision: 1,
      bytes: snapshot,
    });

    await runtime.dispose();
  });

  it("fails closed when safe cross-tab locking is unavailable", async () => {
    await expect(
      initializeBrowserRuntime({
        store: createMemoryWorkspaceStore(),
        lifecycleTarget: null,
        lockManager: null,
        dependencies: createDependencies(),
      }),
    ).rejects.toMatchObject<Partial<BrowserWorkspaceLockError>>({
      code: "unsupported",
    });
  });

  it("rejects a second tab and releases the first lock on dispose", async () => {
    const locks = createExclusiveLockManager();
    const first = await initializeBrowserRuntime({
      store: createMemoryWorkspaceStore(),
      lifecycleTarget: null,
      lockManager: locks.lockManager,
      dependencies: createDependencies(),
    });

    await expect(
      initializeBrowserRuntime({
        store: createMemoryWorkspaceStore(),
        lifecycleTarget: null,
        lockManager: locks.lockManager,
        dependencies: createDependencies(),
      }),
    ).rejects.toMatchObject<Partial<BrowserWorkspaceLockError>>({
      code: "already-open",
    });

    await first.dispose();
    expect(locks.held.size).toBe(0);
  });

  it("turns stale writes into an explicit user-facing stop message", () => {
    expect(
      browserPersistenceFailureMessage(
        new BrowserWorkspaceError("stale-write", "conflict"),
      ),
    ).toContain("保存競合");
  });
});
