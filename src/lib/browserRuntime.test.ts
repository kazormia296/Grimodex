import { describe, expect, it, vi } from "vitest";
import {
  BrowserWorkspaceError,
  computeAiAuditJournalBatchId,
  createMemoryWorkspaceStore,
} from "./browser-db/indexedDbStore";
import {
  assertWebEditorDurability,
  browserPersistenceFailureMessage,
  BrowserWorkspaceLockError,
  clearRetiredBrowserModelCaches,
  createWebEditorWorkspaceStore,
  initializeBrowserRuntime,
  RETIRED_BROWSER_MODEL_CACHE_NAMES,
  WEB_EDITOR_WORKSPACE_ID,
  type BrowserRuntimeDependencies,
} from "./browserRuntime";
import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

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
    invoke: vi.fn(async () => undefined),
    exportDatabase: vi.fn(() => bytes),
    close: vi.fn(),
  };
}

async function auditJournalBatch(
  eventId: string,
  eventType = "execution.started",
  projectId = "default-project",
) {
  const sha256 = async (value: string): Promise<string> => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return value;
  };
  const payload = canonicalize({
    appVersion: "unknown",
    auditSchemaVersion: 1,
    captureContractVersion: 1,
    captureState: "complete",
    credentialsExcluded: true,
    recorder: "grimodex-ai-audit",
    request: {
      messages: [{ role: "user", content: "restart prompt" }],
    },
  }) as Record<string, unknown>;
  const payloadSha256 = await sha256(JSON.stringify(payload));
  const scopeId = projectId === null ? "workspace" : `project:${projectId}`;
  const prevHash = "0".repeat(64);
  const hash = await sha256(
    JSON.stringify({
      scopeId,
      projectId,
      sequence: 1,
      eventId,
      executionId: "execution-restart",
      operationId: "operation-restart",
      parentExecutionId: null,
      pathId: "browser_byok_web",
      eventType,
      timestamp: 1,
      recordedAt: 1,
      payloadSha256,
      prevHash,
    }),
  );
  const journal = canonicalize({
    journalVersion: 1,
    auditSchemaVersion: 1,
    captureContractVersion: 1,
    expectedWorkspacePath: "/dev/workspace",
    projectId,
    scopeId,
    baseSequence: 0,
    baseTailHash: prevHash,
    events: [
      {
        sequence: 1,
        scopeId,
        projectId,
        eventId,
        executionId: "execution-restart",
        operationId: "operation-restart",
        parentExecutionId: null,
        pathId: "browser_byok_web",
        eventType,
        timestamp: 1,
        recordedAt: 1,
        payload,
        payloadSha256,
        prevHash,
        hash,
      },
    ],
  });
  const appendArgsJson = JSON.stringify(journal);
  return {
    batchId: await computeAiAuditJournalBatchId(appendArgsJson),
    appendArgsJson,
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
  it("deletes only the retired browser-model Cache Storage scopes", async () => {
    const deleteCache = vi.fn(async (_name: string) => true);

    await clearRetiredBrowserModelCaches({
      delete: deleteCache,
    } as Pick<CacheStorage, "delete">);

    expect(deleteCache.mock.calls.map(([name]) => name)).toEqual([
      ...RETIRED_BROWSER_MODEL_CACHE_NAMES,
    ]);
  });

  it("does not block startup when retired browser-model cache cleanup fails", async () => {
    const deleteCache = vi
      .fn<(name: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("cache unavailable"))
      .mockResolvedValue(true);
    const dependencies = createDependencies();

    const runtime = await initializeBrowserRuntime({
      store: createMemoryWorkspaceStore(),
      lifecycleTarget: null,
      lockManager: createExclusiveLockManager().lockManager,
      cacheStorage: {
        delete: deleteCache,
      } as Pick<CacheStorage, "delete">,
      dependencies,
    });

    expect(deleteCache).toHaveBeenCalledTimes(
      RETIRED_BROWSER_MODEL_CACHE_NAMES.length,
    );
    expect(dependencies.createBrowserMock).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("fails closed when IndexedDB is unavailable", () => {
    expect(() =>
      createWebEditorWorkspaceStore({ indexedDB: null }),
    ).toThrowError(
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

  it("replays a journal for a project absent from the persisted snapshot", async () => {
    const store = createMemoryWorkspaceStore();
    const baseline = await createBrowserMock({
      workspaceIdentity: "/dev/workspace",
    });
    const baselineBytes = baseline.exportDatabase();
    baseline.close();
    await store.put({
      workspaceId: WEB_EDITOR_WORKSPACE_ID,
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-08-03T00:00:00.000Z",
      bytes: baselineBytes,
    });
    await store.appendAiAuditJournal({
      workspaceId: WEB_EDITOR_WORKSPACE_ID,
      expectedRevision: 1,
      createdAt: "2026-08-03T00:00:01.000Z",
      ...(await auditJournalBatch(
        "journal-only-event",
        "execution.started",
        "memory-only-project",
      )),
    });
    let installed: PersistentBrowserMock | null = null;
    const dependencies: BrowserRuntimeDependencies = {
      createBrowserMock,
      installBrowserMock: (database) => {
        installed = database as PersistentBrowserMock;
      },
    };

    const runtime = await initializeBrowserRuntime({
      store,
      lifecycleTarget: null,
      lockManager: createExclusiveLockManager().lockManager,
      dependencies,
    });

    expect(installed).not.toBeNull();
    await expect(
      installed!.invoke("ai_audit_read_snapshot", {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "memory-only-project",
      }),
    ).resolves.toMatchObject({
      highWaterSequence: 1,
      events: [expect.objectContaining({ eventId: "journal-only-event" })],
    });
    await expect(
      store.readAiAuditJournal(WEB_EDITOR_WORKSPACE_ID),
    ).resolves.toEqual([]);
    await expect(store.get(WEB_EDITOR_WORKSPACE_ID)).resolves.toMatchObject({
      revision: 2,
    });
    await runtime.dispose();

    let reinstalled: PersistentBrowserMock | null = null;
    const restarted = await initializeBrowserRuntime({
      store,
      lifecycleTarget: null,
      lockManager: createExclusiveLockManager().lockManager,
      dependencies: {
        createBrowserMock,
        installBrowserMock: (database) => {
          reinstalled = database as PersistentBrowserMock;
        },
      },
    });
    await expect(
      reinstalled!.invoke("ai_audit_read_snapshot", {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "memory-only-project",
      }),
    ).resolves.toMatchObject({
      highWaterSequence: 1,
      events: [expect.objectContaining({ eventId: "journal-only-event" })],
    });
    await restarted.dispose();
  });

  it("keeps BrowserMock unavailable until startup journal replay completes", async () => {
    const store = createMemoryWorkspaceStore();
    await store.appendAiAuditJournal({
      workspaceId: WEB_EDITOR_WORKSPACE_ID,
      expectedRevision: 0,
      createdAt: "2026-08-03T00:00:00.000Z",
      ...(await auditJournalBatch("startup-gate")),
    });
    let releaseReplay!: () => void;
    let markReplayStarted!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const replayStarted = new Promise<void>((resolve) => {
      markReplayStarted = resolve;
    });
    const database = createMockDatabase();
    database.invoke.mockImplementation(async () => {
      markReplayStarted();
      await replayGate;
    });
    const dependencies = createDependencies({
      createBrowserMock: vi.fn(async () => database),
    });

    const initializing = initializeBrowserRuntime({
      store,
      lifecycleTarget: null,
      lockManager: createExclusiveLockManager().lockManager,
      dependencies,
    });
    await replayStarted;
    expect(dependencies.installBrowserMock).not.toHaveBeenCalled();

    releaseReplay();
    const runtime = await initializing;
    expect(dependencies.installBrowserMock).toHaveBeenCalledWith(database);
    await runtime.dispose();
  });

  it("fails closed without installing BrowserMock when journal replay fails", async () => {
    const store = createMemoryWorkspaceStore();
    const validBatch = await auditJournalBatch("invalid-replay");
    const invalidReplayArgs = JSON.parse(validBatch.appendArgsJson) as Record<
      string,
      unknown
    >;
    invalidReplayArgs.expectedWorkspacePath = "/different/workspace";
    const invalidReplayArgsJson = JSON.stringify(invalidReplayArgs);
    await store.appendAiAuditJournal({
      workspaceId: WEB_EDITOR_WORKSPACE_ID,
      expectedRevision: 0,
      createdAt: "2026-08-03T00:00:00.000Z",
      batchId: await computeAiAuditJournalBatchId(invalidReplayArgsJson),
      appendArgsJson: invalidReplayArgsJson,
    });
    const database = createMockDatabase();
    const replayError = new Error("journal replay rejected");
    database.invoke.mockRejectedValue(replayError);
    const dependencies = createDependencies({
      createBrowserMock: vi.fn(async () => database),
    });
    const locks = createExclusiveLockManager();

    await expect(
      initializeBrowserRuntime({
        store,
        lifecycleTarget: null,
        lockManager: locks.lockManager,
        dependencies,
      }),
    ).rejects.toBe(replayError);
    expect(database.invoke).toHaveBeenCalledWith(
      "ai_audit_restore_batch",
      invalidReplayArgs,
    );
    expect(dependencies.installBrowserMock).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalledOnce();
    expect(locks.held.size).toBe(0);
  });

  it("rejects a tampered journal digest before replaying it into BrowserMock", async () => {
    const store = createMemoryWorkspaceStore();
    const validBatch = await auditJournalBatch("tampered-replay");
    store.readAiAuditJournal = vi.fn(async () => [
      {
        workspaceId: WEB_EDITOR_WORKSPACE_ID,
        sequence: 1,
        createdAt: "2026-08-03T00:00:00.000Z",
        ...validBatch,
        batchId: "0".repeat(64),
      },
    ]);
    const database = createMockDatabase();
    const dependencies = createDependencies({
      createBrowserMock: vi.fn(async () => database),
    });

    await expect(
      initializeBrowserRuntime({
        store,
        lifecycleTarget: null,
        lockManager: createExclusiveLockManager().lockManager,
        dependencies,
      }),
    ).rejects.toMatchObject({
      code: "storage-failed",
      message: expect.stringMatching(/does not match appendArgsJson/iu),
    });
    expect(database.invoke).not.toHaveBeenCalled();
    expect(dependencies.installBrowserMock).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("uses journal ACKs for many audit partials without full snapshot exports", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryWorkspaceStore();
      const put = vi.spyOn(store, "put");
      const database = createMockDatabase();
      let markDirty!: () => void;
      let acknowledgeAudit!: NonNullable<
        Parameters<
          BrowserRuntimeDependencies["createBrowserMock"]
        >[0]["onAiAuditDurabilityRequired"]
      >;
      const dependencies = createDependencies({
        createBrowserMock: vi.fn(async (options) => {
          markDirty = options.onDatabaseDirty!;
          acknowledgeAudit = options.onAiAuditDurabilityRequired!;
          return database;
        }),
      });
      const runtime = await initializeBrowserRuntime({
        store,
        lifecycleTarget: null,
        lockManager: createExclusiveLockManager().lockManager,
        debounceMs: 2_000,
        dependencies,
      });

      for (let index = 0; index < 128; index += 1) {
        markDirty();
        await acknowledgeAudit(await auditJournalBatch(`partial-${index}`));
      }

      expect(database.exportDatabase).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      await expect(
        store.readAiAuditJournal(WEB_EDITOR_WORKSPACE_ID),
      ).resolves.toHaveLength(128);

      vi.clearAllTimers();
      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
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
