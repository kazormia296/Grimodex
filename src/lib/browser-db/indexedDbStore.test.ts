import { describe, expect, it } from "vitest";
import {
  BrowserWorkspaceError,
  createMemoryWorkspaceStore,
} from "./indexedDbStore";

describe("browser workspace snapshot store", () => {
  it("stores bytes with metadata and restores the latest revision", async () => {
    const store = createMemoryWorkspaceStore();

    await store.put({
      workspaceId: "workspace-1",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([1, 2, 3]),
    });

    await expect(store.get("workspace-1")).resolves.toMatchObject({
      workspaceId: "workspace-1",
      revision: 1,
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("rejects stale writes so an older flush cannot overwrite newer data", async () => {
    const store = createMemoryWorkspaceStore();
    await store.put({
      workspaceId: "workspace-1",
      revision: 2,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:02.000Z",
      bytes: new Uint8Array([2]),
    });

    await expect(
      store.put({
        workspaceId: "workspace-1",
        revision: 1,
        schemaVersion: 1,
        updatedAt: "2026-07-16T00:00:01.000Z",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: "stale-write" });
    await expect(store.get("workspace-1")).resolves.toMatchObject({
      revision: 2,
      bytes: new Uint8Array([2]),
    });
  });

  it("supports rename and deletion without leaving metadata", async () => {
    const store = createMemoryWorkspaceStore();
    await store.put({
      workspaceId: "workspace-1",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([1]),
    });

    await store.rename("workspace-1", "workspace-renamed");
    await expect(store.get("workspace-1")).resolves.toBeUndefined();
    await expect(store.get("workspace-renamed")).resolves.toMatchObject({
      workspaceId: "workspace-renamed",
    });
    await store.delete("workspace-renamed");
    await expect(store.list()).resolves.toEqual([]);
  });

  it("exposes a stable user-facing error for quota failures", () => {
    const error = new BrowserWorkspaceError(
      "quota-exceeded",
      "Workspace storage is full",
    );

    expect(error.code).toBe("quota-exceeded");
    expect(error.message).toBe("Workspace storage is full");
  });
});
