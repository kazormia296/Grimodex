import { describe, expect, it, vi } from "vitest";
import { createMemoryWorkspaceStore } from "./browser-db/indexedDbStore";
import {
  HOSTED_AI_SESSION_STORAGE_KEY,
  HOSTED_EDITOR_ENTRY_MODE_STORAGE_KEY,
  initializeBrowserRuntime,
  type BrowserRuntimeDependencies,
} from "./browserRuntime";

function createLockManager(): Pick<LockManager, "request"> {
  return {
    request: vi.fn(async (_name, _options, callback) =>
      callback({ name: "web-editor", mode: "exclusive" } as Lock),
    ) as unknown as LockManager["request"],
  };
}

describe("browser runtime editor-only contract", () => {
  it("ignores and clears legacy Scan state without making a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const replaceHistory = vi.fn();
    const values = new Map<string, string>([
      [
        HOSTED_AI_SESSION_STORAGE_KEY,
        JSON.stringify({
          scanId: "legacy-scan",
          token: "a".repeat(64),
          expiresAt: "2099-07-20T00:00:00.000Z",
        }),
      ],
      [HOSTED_EDITOR_ENTRY_MODE_STORAGE_KEY, "scan"],
    ]);
    const sessionStorage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    };
    const database = {
      exportDatabase: vi.fn(() => new Uint8Array([1, 2, 3])),
      close: vi.fn(),
    };
    const dependencies = {
      createBrowserMock: vi.fn(async () => database),
      installBrowserMock: vi.fn(),
    } satisfies BrowserRuntimeDependencies;

    const runtime = await initializeBrowserRuntime({
      store: createMemoryWorkspaceStore(),
      lifecycleTarget: null,
      lockManager: createLockManager(),
      href: "https://try.grimodex.app/editor#scan-import=legacy-token",
      fetchImpl,
      replaceHistory,
      sessionStorage,
      dependencies,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(replaceHistory).toHaveBeenCalledWith(
      "https://try.grimodex.app/editor",
    );
    expect(sessionStorage.removeItem).toHaveBeenCalledWith(
      HOSTED_AI_SESSION_STORAGE_KEY,
    );
    expect(sessionStorage.removeItem).toHaveBeenCalledWith(
      HOSTED_EDITOR_ENTRY_MODE_STORAGE_KEY,
    );
    expect(dependencies.createBrowserMock).toHaveBeenCalledWith({
      databaseBytes: undefined,
      onDatabaseDirty: expect.any(Function),
    });
    expect(runtime).not.toHaveProperty("entryMode");
    expect(runtime).not.toHaveProperty("importedProjectId");

    await runtime.dispose();
  });
});
