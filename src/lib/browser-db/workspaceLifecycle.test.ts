import { describe, expect, it } from "vitest";
import { createMemoryWorkspaceStore } from "./indexedDbStore";
import { createBrowserWorkspaceLifecycle } from "./workspaceLifecycle";

describe("browser workspace lifecycle", () => {
  it("opens valid snapshots and reports decoder failures without deleting data", async () => {
    const store = createMemoryWorkspaceStore();
    await store.put({
      workspaceId: "scan:one",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new TextEncoder().encode('{"ok":true}'),
    });
    const lifecycle = createBrowserWorkspaceLifecycle(store);

    await expect(
      lifecycle.open("scan:one", (bytes) =>
        JSON.parse(new TextDecoder().decode(bytes)),
      ),
    ).resolves.toMatchObject({
      status: "opened",
      value: { ok: true },
    });
    await expect(
      lifecycle.open("scan:one", () => {
        throw new Error("bad snapshot");
      }),
    ).resolves.toMatchObject({
      status: "corrupt",
    });
    await expect(store.get("scan:one")).resolves.toBeDefined();
  });

  it("supports rename/remove and rejects blank names", async () => {
    const store = createMemoryWorkspaceStore();
    await store.put({
      workspaceId: "old",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([1]),
    });
    const lifecycle = createBrowserWorkspaceLifecycle(store);
    await lifecycle.rename("old", "new");
    await expect(lifecycle.rename("new", "  ")).rejects.toMatchObject({
      code: "storage-failed",
    });
    await lifecycle.remove("new");
    await expect(lifecycle.open("new", () => null)).resolves.toMatchObject({
      status: "missing",
    });
  });
});
