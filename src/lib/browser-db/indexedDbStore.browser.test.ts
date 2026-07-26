import { describe, expect, it } from "vitest";
import { createIndexedDbWorkspaceStore } from "./indexedDbStore";

function databaseName(label: string): string {
  return `grimodex-indexeddb-test-${label}-${crypto.randomUUID()}`;
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

describe("IndexedDB browser workspace store", () => {
  it("atomically stores, rejects stale writes, renames, and tombstones", async () => {
    const store = createIndexedDbWorkspaceStore({
      dbName: databaseName("lifecycle"),
    });
    await store.put({
      workspaceId: "draft",
      revision: 1,
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([1, 2, 3]),
    });

    await expect(store.get("draft")).resolves.toMatchObject({
      revision: 1,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(
      store.put({
        workspaceId: "draft",
        revision: 1,
        schemaVersion: 2,
        updatedAt: "2026-07-16T00:00:01.000Z",
        bytes: new Uint8Array([9]),
      }),
    ).rejects.toMatchObject({ code: "stale-write" });

    await store.rename("draft", "renamed");
    await expect(store.get("draft")).resolves.toBeUndefined();
    await expect(store.getState("draft")).resolves.toMatchObject({
      deleted: true,
      revision: 2,
    });
    await expect(store.get("renamed")).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
    });

    await store.delete("renamed");
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.getState("renamed")).resolves.toMatchObject({
      deleted: true,
    });
  });

  it("reports live metadata with a missing blob as corruption", async () => {
    const dbName = databaseName("missing-blob");
    const store = createIndexedDbWorkspaceStore({ dbName });
    await store.put({
      workspaceId: "damaged",
      revision: 1,
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      bytes: new Uint8Array([4, 5, 6]),
    });
    const database = await openDatabase(dbName);
    const transaction = database.transaction("workspace_blobs", "readwrite");
    transaction.objectStore("workspace_blobs").delete(["damaged", 1]);
    await transactionComplete(transaction);
    database.close();

    await expect(store.get("damaged")).rejects.toMatchObject({
      code: "storage-failed",
    });
  });
});
