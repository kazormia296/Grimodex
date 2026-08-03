import { describe, expect, it } from "vitest";
import {
  BrowserWorkspaceError,
  computeAiAuditJournalBatchId,
  createFailoverWorkspaceStore,
  createMemoryWorkspaceStore,
} from "./indexedDbStore";

async function journalBatch(appendArgsJson: string) {
  return {
    batchId: await computeAiAuditJournalBatchId(appendArgsJson),
    appendArgsJson,
  };
}

describe("browser workspace snapshot store", () => {
  it("keeps ordered AI audit batches and exact retries idempotent", async () => {
    const store = createMemoryWorkspaceStore();
    const append = async (appendArgsJson: string) =>
      store.appendAiAuditJournal({
        workspaceId: "workspace-1",
        expectedRevision: 0,
        ...(await journalBatch(appendArgsJson)),
        createdAt: "2026-08-03T00:00:00.000Z",
      });

    const firstJson = '{"events":[{"eventId":"1"}]}';
    const secondJson = '{"events":[{"eventId":"2"}]}';
    const first = await append(firstJson);
    const exactRetry = await append(firstJson);
    const second = await append(secondJson);

    expect(first).toMatchObject({ sequence: 1 });
    expect(first.batchId).toMatch(/^[0-9a-f]{64}$/u);
    expect(exactRetry).toEqual(first);
    expect(second).toMatchObject({ sequence: 2 });
    await expect(store.readAiAuditJournal("workspace-1")).resolves.toEqual([
      first,
      second,
    ]);
    await expect(
      store.appendAiAuditJournal({
        workspaceId: "workspace-1",
        expectedRevision: 0,
        batchId: first.batchId,
        appendArgsJson: '{"events":[{"eventId":"different"}]}',
        createdAt: "2026-08-03T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "storage-failed" });
  });

  it("moves and deletes workspace-scoped AI audit journal records", async () => {
    const store = createMemoryWorkspaceStore();
    await store.put({
      workspaceId: "source",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-08-03T00:00:00.000Z",
      bytes: new Uint8Array([1]),
    });
    const batch = await journalBatch('{"events":[{"eventId":"1"}]}');
    await store.appendAiAuditJournal({
      workspaceId: "source",
      expectedRevision: 1,
      ...batch,
      createdAt: "2026-08-03T00:00:01.000Z",
    });

    await store.rename("source", "renamed");
    await expect(store.readAiAuditJournal("source")).resolves.toEqual([]);
    await expect(store.readAiAuditJournal("renamed")).resolves.toEqual([
      expect.objectContaining({
        workspaceId: "renamed",
        sequence: 1,
        batchId: batch.batchId,
      }),
    ]);

    await store.delete("renamed");
    await expect(store.readAiAuditJournal("renamed")).resolves.toEqual([]);
  });

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

  it("reuses a deleted rename destination at a newer tombstone revision", async () => {
    const store = createMemoryWorkspaceStore();
    const snapshot = (workspaceId: string, value: number) => ({
      workspaceId,
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([value]),
    });
    await store.put(snapshot("source", 1));
    await store.put(snapshot("destination", 2));
    await store.delete("destination");

    await store.rename("source", "destination");

    await expect(store.get("destination")).resolves.toMatchObject({
      revision: 3,
      bytes: new Uint8Array([1]),
    });
    await expect(store.get("source")).resolves.toBeUndefined();
  });

  it("does not overwrite a live workspace during rename", async () => {
    const store = createMemoryWorkspaceStore();
    for (const workspaceId of ["source", "destination"]) {
      await store.put({
        workspaceId,
        revision: 1,
        schemaVersion: 1,
        updatedAt: "2026-07-16T00:00:00.000Z",
        bytes: new Uint8Array([1]),
      });
    }

    await expect(store.rename("source", "destination")).rejects.toMatchObject({
      code: "stale-write",
    });
  });

  it("exposes a stable user-facing error for quota failures", () => {
    const error = new BrowserWorkspaceError(
      "quota-exceeded",
      "Workspace storage is full",
    );

    expect(error.code).toBe("quota-exceeded");
    expect(error.message).toBe("Workspace storage is full");
  });

  it("falls back when the primary store cannot complete its first async operation", async () => {
    const fallback = createMemoryWorkspaceStore();
    const primary = createMemoryWorkspaceStore();
    primary.get = async () => {
      throw new BrowserWorkspaceError(
        "storage-failed",
        "IndexedDB open failed",
      );
    };
    const store = createFailoverWorkspaceStore(primary, fallback);

    await expect(store.get("workspace-1")).resolves.toBeUndefined();
    await store.put({
      workspaceId: "workspace-1",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([7]),
    });
    await expect(store.get("workspace-1")).resolves.toMatchObject({
      revision: 1,
      bytes: new Uint8Array([7]),
    });
    expect(store.getDurability()).toBe("memory");
  });

  it("does not hide failures after the primary store has succeeded", async () => {
    const primary = createMemoryWorkspaceStore();
    const store = createFailoverWorkspaceStore(
      primary,
      createMemoryWorkspaceStore(),
    );
    await expect(store.list()).resolves.toEqual([]);
    primary.get = async () => {
      throw new BrowserWorkspaceError("storage-failed", "read failed");
    };

    await expect(store.get("workspace-1")).rejects.toMatchObject({
      code: "storage-failed",
    });
  });

  it("routes concurrent startup operations through the same selected store", async () => {
    let releasePrimary!: () => void;
    const primaryGate = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    let primaryGetCalls = 0;
    const primary = createMemoryWorkspaceStore();
    primary.list = async () => {
      await primaryGate;
      throw new BrowserWorkspaceError("storage-failed", "open failed");
    };
    primary.get = async () => {
      primaryGetCalls += 1;
      return undefined;
    };
    const store = createFailoverWorkspaceStore(
      primary,
      createMemoryWorkspaceStore(),
    );

    const list = store.list();
    const get = store.get("workspace-1");
    releasePrimary();

    await expect(list).resolves.toEqual([]);
    await expect(get).resolves.toBeUndefined();
    expect(primaryGetCalls).toBe(0);
  });
});
