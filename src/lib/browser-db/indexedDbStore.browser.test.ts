import { describe, expect, it } from "vitest";
import {
  computeAiAuditJournalBatchId,
  createIndexedDbWorkspaceStore,
} from "./indexedDbStore";

async function journalBatch(appendArgsJson: string) {
  return {
    batchId: await computeAiAuditJournalBatchId(appendArgsJson),
    appendArgsJson,
  };
}

function databaseName(label: string): string {
  return `grimodex-indexeddb-test-${label}-${crypto.randomUUID()}`;
}

function openDatabase(
  name: string,
  version?: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(name)
        : indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
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
  it("upgrades a v1 snapshot database and adds the durable AI audit journal", async () => {
    const dbName = databaseName("v1-migration");
    const legacy = await openDatabase(dbName, 1, (database) => {
      database.createObjectStore("workspace_metadata", {
        keyPath: "workspaceId",
      });
      database.createObjectStore("workspace_blobs", {
        keyPath: ["workspaceId", "revision"],
      });
    });
    const seed = legacy.transaction(
      ["workspace_metadata", "workspace_blobs"],
      "readwrite",
    );
    seed.objectStore("workspace_metadata").put({
      workspaceId: "legacy",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-08-03T00:00:00.000Z",
      size: 3,
    });
    seed.objectStore("workspace_blobs").put({
      workspaceId: "legacy",
      revision: 1,
      bytes: new Uint8Array([1, 2, 3]).buffer,
    });
    await transactionComplete(seed);
    legacy.close();

    const store = createIndexedDbWorkspaceStore({ dbName });
    await expect(store.get("legacy")).resolves.toMatchObject({
      revision: 1,
      bytes: new Uint8Array([1, 2, 3]),
    });
    const upgradeBatch = await journalBatch(
      '{"events":[{"eventId":"event-1"}]}',
    );
    await store.appendAiAuditJournal({
      workspaceId: "legacy",
      expectedRevision: 1,
      ...upgradeBatch,
      createdAt: "2026-08-03T00:00:01.000Z",
    });
    await expect(store.readAiAuditJournal("legacy")).resolves.toEqual([
      expect.objectContaining({ sequence: 1, batchId: upgradeBatch.batchId }),
    ]);

    const upgraded = await openDatabase(dbName);
    expect(upgraded.version).toBe(2);
    expect([...upgraded.objectStoreNames]).toEqual(
      expect.arrayContaining([
        "workspace_metadata",
        "workspace_blobs",
        "workspace_ai_audit_journal",
        "workspace_ai_audit_journal_state",
      ]),
    );
    upgraded.close();
  });

  it("deduplicates exact journal retries and rejects digest collisions", async () => {
    const dbName = databaseName("journal-idempotency");
    const store = createIndexedDbWorkspaceStore({
      dbName,
    });
    const input = {
      workspaceId: "draft",
      expectedRevision: 0,
      ...(await journalBatch('{"events":[{"eventId":"event-1"}]}')),
      createdAt: "2026-08-03T00:00:00.000Z",
    };

    const first = await store.appendAiAuditJournal(input);
    const retry = await store.appendAiAuditJournal(input);

    expect(retry).toEqual(first);
    await expect(store.readAiAuditJournal("draft")).resolves.toHaveLength(1);
    await expect(
      store.appendAiAuditJournal({
        ...input,
        appendArgsJson: '{"events":[{"eventId":"different"}]}',
      }),
    ).rejects.toMatchObject({ code: "storage-failed" });

    const database = await openDatabase(dbName);
    const tamper = database.transaction(
      "workspace_ai_audit_journal",
      "readwrite",
    );
    tamper.objectStore("workspace_ai_audit_journal").put({
      ...first,
      batchId: "0".repeat(64),
    });
    await transactionComplete(tamper);
    database.close();
    await expect(store.readAiAuditJournal("draft")).rejects.toMatchObject({
      code: "storage-failed",
    });

    await store.put({
      workspaceId: "draft",
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-08-03T00:00:01.000Z",
      bytes: new Uint8Array([1]),
      auditJournalCompactionWatermark: first.sequence,
    });
    await expect(store.readAiAuditJournal("draft")).resolves.toEqual([]);
    await expect(
      store.getAiAuditJournalHighWatermark("draft", 1),
    ).resolves.toBe(0);
    await expect(
      store.appendAiAuditJournal({
        ...input,
        expectedRevision: 1,
        ...(await journalBatch('{"events":[{"eventId":"event-2"}]}')),
      }),
    ).resolves.toMatchObject({ sequence: 2 });
  });

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
    const renameBatch = await journalBatch(
      '{"events":[{"eventId":"rename-event"}]}',
    );
    await store.appendAiAuditJournal({
      workspaceId: "draft",
      expectedRevision: 1,
      ...renameBatch,
      createdAt: "2026-08-03T00:00:00.000Z",
    });

    await store.rename("draft", "renamed");
    await expect(store.get("draft")).resolves.toBeUndefined();
    await expect(store.getState("draft")).resolves.toMatchObject({
      deleted: true,
      revision: 2,
    });
    await expect(store.get("renamed")).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(store.readAiAuditJournal("draft")).resolves.toEqual([]);
    await expect(store.readAiAuditJournal("renamed")).resolves.toEqual([
      expect.objectContaining({
        workspaceId: "renamed",
        sequence: 1,
        batchId: renameBatch.batchId,
      }),
    ]);

    await store.delete("renamed");
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.getState("renamed")).resolves.toMatchObject({
      deleted: true,
    });
    await expect(store.readAiAuditJournal("renamed")).resolves.toEqual([]);
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
