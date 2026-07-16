import { describe, expect, it } from "vitest";
import {
  BrowserWorkspaceError,
  createMemoryWorkspaceStore,
} from "../../../../src/lib/browser-db/indexedDbStore";
import {
  createBrowserWorkspaceStore,
  saveWorkspaceCopy,
} from "./browserWorkspaceStore";

describe("saveWorkspaceCopy", () => {
  it("preserves conflict edits under a new workspace id", async () => {
    const store = createMemoryWorkspaceStore();
    await saveWorkspaceCopy(store, {
      workspaceId: "scan:copy",
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([4, 2]),
    });

    await expect(store.get("scan:copy")).resolves.toMatchObject({
      revision: 1,
      schemaVersion: 2,
      bytes: new Uint8Array([4, 2]),
    });
  });

  it("refuses to overwrite an existing destination", async () => {
    const store = createMemoryWorkspaceStore();
    const input = {
      workspaceId: "scan:copy",
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([1]),
    };
    await saveWorkspaceCopy(store, input);

    await expect(
      saveWorkspaceCopy(store, { ...input, bytes: new Uint8Array([2]) }),
    ).rejects.toMatchObject({ code: "stale-write" });
    await expect(store.get("scan:copy")).resolves.toMatchObject({
      bytes: new Uint8Array([1]),
    });
  });

  it("can intentionally reuse a deleted destination name", async () => {
    const store = createMemoryWorkspaceStore();
    await saveWorkspaceCopy(store, {
      workspaceId: "scan:copy",
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([1]),
    });
    await store.delete("scan:copy");

    await saveWorkspaceCopy(store, {
      workspaceId: "scan:copy",
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:01.000Z",
      bytes: new Uint8Array([2]),
    });

    await expect(store.get("scan:copy")).resolves.toMatchObject({
      revision: 3,
      bytes: new Uint8Array([2]),
    });
  });
});

describe("createBrowserWorkspaceStore", () => {
  it("shares the selected production store between launcher and editor", () => {
    expect(createBrowserWorkspaceStore()).toBe(createBrowserWorkspaceStore());
  });

  it("recovers from an asynchronous primary open failure", async () => {
    const primary = createMemoryWorkspaceStore();
    primary.get = async () => {
      throw new BrowserWorkspaceError("storage-failed", "open failed");
    };
    const fallback = createMemoryWorkspaceStore();
    const store = createBrowserWorkspaceStore({
      primaryStore: primary,
      fallbackStore: fallback,
    });

    await expect(store.get("scan:test")).resolves.toBeUndefined();
    await store.put({
      workspaceId: "scan:test",
      revision: 1,
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([9]),
    });
    await expect(fallback.get("scan:test")).resolves.toMatchObject({
      bytes: new Uint8Array([9]),
    });
    expect(store.getDurability()).toBe("memory");
  });
});
