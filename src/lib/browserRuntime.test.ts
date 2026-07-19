import { describe, expect, it, vi } from "vitest";
import {
  BrowserWorkspaceError,
  createMemoryWorkspaceStore,
} from "./browser-db/indexedDbStore";
import {
  assertHostedEditorDurability,
  browserPersistenceFailureMessage,
  BrowserWorkspaceLockError,
  createHostedEditorWorkspaceStore,
  HOSTED_EDITOR_WORKSPACE_ID,
  initializeBrowserRuntime,
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
    invoke: vi.fn(),
    exportDatabase: vi.fn(() => bytes),
    close: vi.fn(),
  };
}

const hostedAiSession = {
  scanId: "scan-123",
  token: "a".repeat(64),
  expiresAt: "2099-07-20T00:00:00.000Z",
};

function createSessionStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

function createDependencies(
  overrides: Partial<BrowserRuntimeDependencies> = {},
): BrowserRuntimeDependencies {
  return {
    createBrowserMock: vi.fn(async () => createMockDatabase()),
    installBrowserMock: vi.fn(),
    consumeEditorSeedHandoff: vi.fn(async () => null),
    parseEditorSeed: vi.fn(() => ({
      ok: false as const,
      errors: [{ code: "unused", path: "/", message: "unused" }],
    })),
    buildScanImportPlan: vi.fn(),
    createScanImportOperationsForPlan: vi.fn(),
    applyScanImportPlan: vi.fn(),
    applyUiLanguage: vi.fn(async () => undefined),
    resolveUiLanguage: vi.fn((fallback) => fallback),
    ...overrides,
  };
}

describe("hosted Editor browser runtime", () => {
  it("fails closed when IndexedDB is unavailable", () => {
    expect(() =>
      createHostedEditorWorkspaceStore({ indexedDB: null }),
    ).toThrowError(
      expect.objectContaining<Partial<BrowserWorkspaceError>>({
        code: "unavailable",
      }),
    );
  });

  it("reports the hosted default store as persistent", () => {
    const indexedDB = {
      open: vi.fn(),
    } as unknown as IDBFactory;

    const store = createHostedEditorWorkspaceStore({ indexedDB });

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
        store: createHostedEditorWorkspaceStore({ indexedDB }),
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

  it("rejects non-persistent durability at the hosted bootstrap boundary", () => {
    expect(() => assertHostedEditorDurability("memory")).toThrowError(
      expect.objectContaining<Partial<BrowserWorkspaceError>>({
        code: "unavailable",
      }),
    );
    expect(() => assertHostedEditorDurability("persistent")).not.toThrow();
  });

  it("uses the local Scan Worker for development handoffs without extra env setup", async () => {
    const dependencies = createDependencies();
    const locks = createExclusiveLockManager();

    const runtime = await initializeBrowserRuntime({
      store: createMemoryWorkspaceStore(),
      lifecycleTarget: null,
      href: "http://localhost:1430/editor",
      sessionStorage: null,
      lockManager: locks.lockManager,
      dependencies,
    });

    expect(dependencies.consumeEditorSeedHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBaseUrl: "http://127.0.0.1:8787",
      }),
    );
    const browserMockOptions = vi.mocked(dependencies.createBrowserMock).mock
      .calls[0]?.[0];
    expect(
      browserMockOptions?.aiTransportProvidesProviderAccess,
    ).toBeUndefined();
    await runtime.dispose();
  });

  it("restores the hosted workspace before installing BrowserMock", async () => {
    const store = createMemoryWorkspaceStore();
    const restoredBytes = new Uint8Array([1, 2, 3]);
    await store.put({
      workspaceId: HOSTED_EDITOR_WORKSPACE_ID,
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-19T00:00:00.000Z",
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
      href: "https://try.grimodex.app/editor",
      scanApiBaseUrl: "https://scan.example",
      lockManager: locks.lockManager,
      dependencies,
    });

    expect(dependencies.installBrowserMock).toHaveBeenCalledWith(mock);
    expect(onDatabaseDirty).toBeTypeOf("function");
    onDatabaseDirty?.();
    await runtime.persistence.flush();
    await expect(store.get(HOSTED_EDITOR_WORKSPACE_ID)).resolves.toMatchObject({
      revision: 2,
      bytes: new Uint8Array([4, 5, 6]),
    });
    await runtime.dispose();
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it("validates and imports a Scan handoff before resolving bootstrap", async () => {
    const store = createMemoryWorkspaceStore();
    const mock = createMockDatabase(new Uint8Array([7, 8]));
    const rawSeed = { schemaVersion: "raw" };
    const handoff = {
      schemaVersion: "grimodex/editor-handoff/1",
      seed: rawSeed,
      hostedAiSession,
      uiLanguage: "en" as const,
    };
    const parsedSeed = { schemaVersion: "parsed" };
    const plan = { schemaVersion: "plan" };
    const operations = { stage: "operations" };
    const applyResult = { projectId: "scan-project" };
    const callOrder: string[] = [];
    let currentUiLanguage: "ja" | "en" = "en";
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("stop after disclosure URL capture");
    });
    let authorizeAiRequest:
      | NonNullable<
          Parameters<
            BrowserRuntimeDependencies["createBrowserMock"]
          >[0]["authorizeAiRequest"]
        >
      | undefined;
    const sessionStorage = createSessionStorage();
    const dependencies = createDependencies({
      createBrowserMock: vi.fn(async (options) => {
        callOrder.push("create");
        expect(options.aiSettingsOverride).toMatchObject({
          model: "grimodex-hosted",
        });
        expect(options.authorizeAiRequest).toBeTypeOf("function");
        authorizeAiRequest = options.authorizeAiRequest;
        expect(options.aiTransport).toBeDefined();
        expect(options.aiTransportProvidesProviderAccess).toBe(true);
        return mock;
      }),
      consumeEditorSeedHandoff: vi.fn(async () => {
        callOrder.push("consume");
        return handoff as never;
      }),
      parseEditorSeed: vi.fn(() => {
        callOrder.push("parse");
        return { ok: true as const, value: parsedSeed as never };
      }),
      installBrowserMock: vi.fn(() => callOrder.push("install")),
      buildScanImportPlan: vi.fn(() => {
        callOrder.push("plan");
        return plan as never;
      }),
      createScanImportOperationsForPlan: vi.fn(() => {
        callOrder.push("operations");
        return operations as never;
      }),
      applyScanImportPlan: vi.fn(async () => {
        callOrder.push("apply");
        return applyResult as never;
      }),
      applyUiLanguage: vi.fn(async () => {
        callOrder.push("language");
      }),
      resolveUiLanguage: vi.fn(() => currentUiLanguage),
    });
    const locks = createExclusiveLockManager();

    const runtime = await initializeBrowserRuntime({
      store,
      lifecycleTarget: null,
      href: "https://try.grimodex.app/editor#scan-import=one-time-token",
      scanApiBaseUrl: "https://scan.example",
      fetchImpl: fetchImpl as never,
      replaceHistory: vi.fn(),
      sessionStorage,
      lockManager: locks.lockManager,
      dependencies,
    });

    expect(dependencies.consumeEditorSeedHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "https://try.grimodex.app/editor#scan-import=one-time-token",
        apiBaseUrl: "https://scan.example",
      }),
    );
    expect(dependencies.buildScanImportPlan).toHaveBeenCalledWith(parsedSeed);
    expect(dependencies.createScanImportOperationsForPlan).toHaveBeenCalledWith(
      plan,
    );
    expect(dependencies.applyScanImportPlan).toHaveBeenCalledWith(
      plan,
      operations,
    );
    expect(dependencies.applyUiLanguage).toHaveBeenCalledWith("en");
    expect(sessionStorage.setItem).toHaveBeenCalledWith(
      "grimodex:hosted-ai-session/v1",
      expect.stringContaining('"uiLanguage":"en"'),
    );
    expect(authorizeAiRequest).toBeTypeOf("function");
    if (!authorizeAiRequest) throw new Error("Hosted AI authorization missing");
    await expect(
      authorizeAiRequest({
        operation: "chat",
        provider: "openrouter",
        model: "grimodex-hosted",
        hasApiKey: false,
      }),
    ).rejects.toThrow("stop after disclosure URL capture");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://scan.example/api/v1/ai-disclosures/hosted-editor?locale=en",
    );
    currentUiLanguage = "ja";
    await expect(
      authorizeAiRequest({
        operation: "chat",
        provider: "openrouter",
        model: "grimodex-hosted",
        hasApiKey: false,
      }),
    ).rejects.toThrow("stop after disclosure URL capture");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://scan.example/api/v1/ai-disclosures/hosted-editor?locale=ja",
    );
    expect(callOrder).toEqual([
      "consume",
      "parse",
      "create",
      "install",
      "plan",
      "operations",
      "apply",
      "language",
    ]);
    expect(runtime.importedProjectId).toBe("scan-project");
    expect(runtime.entryMode).toBe("scan");
    await expect(store.get(HOSTED_EDITOR_WORKSPACE_ID)).resolves.toMatchObject({
      revision: 1,
      bytes: new Uint8Array([7, 8]),
    });
    await runtime.dispose();
  });

  it("does not replace the saved Editor UI language for a standalone launch", async () => {
    const dependencies = createDependencies();
    const locks = createExclusiveLockManager();

    const runtime = await initializeBrowserRuntime({
      store: createMemoryWorkspaceStore(),
      lifecycleTarget: null,
      href: "https://try.grimodex.app/editor",
      lockManager: locks.lockManager,
      dependencies,
    });

    expect(dependencies.applyUiLanguage).not.toHaveBeenCalled();
    expect(runtime.entryMode).toBe("standalone");
    await runtime.dispose();
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
    const locks = createExclusiveLockManager();
    const runtime = await initializeBrowserRuntime({
      store,
      lifecycleTarget: null,
      lockManager: locks.lockManager,
      dependencies,
    });

    markDirty?.();
    await expect(runtime.exportWorkspace()).resolves.toEqual(snapshot);
    await expect(store.get(HOSTED_EDITOR_WORKSPACE_ID)).resolves.toMatchObject({
      revision: 1,
      bytes: snapshot,
    });
    expect(mock.exportDatabase).toHaveBeenCalledTimes(2);

    await runtime.dispose();
  });

  it("fails closed without installing a mock when the handoff seed is invalid", async () => {
    const mock = createMockDatabase();
    const dependencies = createDependencies({
      createBrowserMock: vi.fn(async () => mock),
      consumeEditorSeedHandoff: vi.fn(
        async () =>
          ({
            schemaVersion: "grimodex/editor-handoff/1",
            seed: { invalid: true },
            hostedAiSession,
          }) as never,
      ),
      parseEditorSeed: vi.fn(() => ({
        ok: false as const,
        errors: [
          {
            code: "schema:const",
            path: "/schemaVersion",
            message: "invalid editor seed schema version",
          },
        ],
      })),
    });
    const locks = createExclusiveLockManager();

    await expect(
      initializeBrowserRuntime({
        store: createMemoryWorkspaceStore(),
        lifecycleTarget: null,
        href: "https://try.grimodex.app/editor#scan-import=bad-token",
        scanApiBaseUrl: "https://scan.example",
        fetchImpl: vi.fn() as never,
        replaceHistory: vi.fn(),
        lockManager: locks.lockManager,
        dependencies,
      }),
    ).rejects.toThrow(
      "Scan editor seed is invalid: /schemaVersion invalid editor seed schema version",
    );
    expect(locks.held.size).toBe(0);
    expect(dependencies.installBrowserMock).not.toHaveBeenCalled();
    expect(dependencies.applyScanImportPlan).not.toHaveBeenCalled();
    expect(dependencies.createBrowserMock).not.toHaveBeenCalled();
    expect(mock.close).not.toHaveBeenCalled();
  });

  it("restores a scoped hosted AI session only from tab session storage", async () => {
    const sessionStorage = createSessionStorage();
    sessionStorage.setItem(
      "grimodex:hosted-ai-session/v1",
      JSON.stringify({ ...hostedAiSession, uiLanguage: "en" }),
    );
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("stop after restored disclosure URL capture");
    });
    let authorizeAiRequest:
      | NonNullable<
          Parameters<
            BrowserRuntimeDependencies["createBrowserMock"]
          >[0]["authorizeAiRequest"]
        >
      | undefined;
    const dependencies = createDependencies({
      createBrowserMock: vi.fn(async (options) => {
        authorizeAiRequest = options.authorizeAiRequest;
        return createMockDatabase();
      }),
    });
    const locks = createExclusiveLockManager();

    const runtime = await initializeBrowserRuntime({
      store: createMemoryWorkspaceStore(),
      lifecycleTarget: null,
      href: "https://try.grimodex.app/editor",
      scanApiBaseUrl: "https://scan.example",
      fetchImpl,
      sessionStorage,
      lockManager: locks.lockManager,
      dependencies,
    });

    expect(dependencies.createBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSettingsOverride: expect.objectContaining({
          model: "grimodex-hosted",
        }),
        authorizeAiRequest: expect.any(Function),
        aiTransport: expect.any(Object),
        aiTransportProvidesProviderAccess: true,
      }),
    );
    expect(authorizeAiRequest).toBeTypeOf("function");
    if (!authorizeAiRequest) throw new Error("Hosted AI authorization missing");
    await expect(
      authorizeAiRequest({
        operation: "chat",
        provider: "openrouter",
        model: "grimodex-hosted",
        hasApiKey: false,
      }),
    ).rejects.toThrow("stop after restored disclosure URL capture");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://scan.example/api/v1/ai-disclosures/hosted-editor?locale=en",
    );
    await runtime.dispose();
  });

  it("fails closed when safe cross-tab locking is unavailable", async () => {
    const dependencies = createDependencies();

    await expect(
      initializeBrowserRuntime({
        store: createMemoryWorkspaceStore(),
        lifecycleTarget: null,
        lockManager: null,
        dependencies,
      }),
    ).rejects.toMatchObject({
      name: "BrowserWorkspaceLockError",
      code: "unsupported",
    });
    expect(dependencies.createBrowserMock).not.toHaveBeenCalled();
  });

  it("rejects a second tab immediately and releases the lock on dispose", async () => {
    const locks = createExclusiveLockManager();
    const firstDependencies = createDependencies();
    const first = await initializeBrowserRuntime({
      store: createMemoryWorkspaceStore(),
      lifecycleTarget: null,
      lockManager: locks.lockManager,
      dependencies: firstDependencies,
    });
    const secondDependencies = createDependencies();

    await expect(
      initializeBrowserRuntime({
        store: createMemoryWorkspaceStore(),
        lifecycleTarget: null,
        lockManager: locks.lockManager,
        dependencies: secondDependencies,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BrowserWorkspaceLockError>>({
        code: "already-open",
      }),
    );
    expect(secondDependencies.createBrowserMock).not.toHaveBeenCalled();

    await first.dispose();
    expect(locks.held.size).toBe(0);

    const reopened = await initializeBrowserRuntime({
      store: createMemoryWorkspaceStore(),
      lifecycleTarget: null,
      lockManager: locks.lockManager,
      dependencies: createDependencies(),
    });
    expect(locks.held.size).toBe(1);
    await reopened.dispose();
    expect(locks.held.size).toBe(0);
  });

  it("turns stale writes into an explicit user-facing stop message", () => {
    const message = browserPersistenceFailureMessage(
      new BrowserWorkspaceError("stale-write", "newer snapshot exists"),
    );

    expect(message).toContain("保存競合");
    expect(message).toContain("編集を続けず");
  });
});
