export type WorkspaceStorageErrorCode =
  | "unavailable"
  | "stale-write"
  | "quota-exceeded"
  | "not-found"
  | "storage-failed";

export class BrowserWorkspaceError extends Error {
  readonly code: WorkspaceStorageErrorCode;

  constructor(code: WorkspaceStorageErrorCode, message: string) {
    super(message);
    this.name = "BrowserWorkspaceError";
    this.code = code;
  }
}

export interface WorkspaceSnapshotInput {
  workspaceId: string;
  revision: number;
  schemaVersion: number;
  updatedAt: string;
  bytes: Uint8Array;
  /**
   * Journal entries at or below this sequence were captured before this
   * snapshot export started. A durable snapshot put may compact only this
   * prefix, in the same storage transaction as the snapshot commit.
   */
  auditJournalCompactionWatermark?: number;
}

export interface WorkspaceSnapshotMetadata {
  workspaceId: string;
  revision: number;
  schemaVersion: number;
  updatedAt: string;
  size: number;
}

export interface WorkspaceSnapshot extends WorkspaceSnapshotMetadata {
  bytes: Uint8Array;
}

export interface AiAuditJournalBatch {
  /** SHA-256 of appendArgsJson, generated after BrowserMock validation. */
  batchId: string;
  /** Canonical JSON for a versioned, materialized audit-batch restore. */
  appendArgsJson: string;
}

/** Journal payload format used after SQLite accepts an AI audit batch. */
export const AI_AUDIT_JOURNAL_FORMAT_VERSION = 1 as const;

export interface AiAuditJournalMaterializedEvent {
  sequence: number;
  scopeId: string;
  projectId: string | null;
  eventId: string;
  executionId: string;
  operationId: string;
  parentExecutionId: string | null;
  pathId: string;
  eventType: string;
  timestamp: number;
  recordedAt: number;
  payload: Record<string, unknown>;
  payloadSha256: string;
  prevHash: string;
  hash: string;
}

export interface AiAuditJournalMaterializedBatch {
  journalVersion: typeof AI_AUDIT_JOURNAL_FORMAT_VERSION;
  auditSchemaVersion: number;
  captureContractVersion: number;
  expectedWorkspacePath: string;
  projectId: string | null;
  scopeId: string;
  baseSequence: number;
  baseTailHash: string;
  events: AiAuditJournalMaterializedEvent[];
}

export interface AiAuditJournalAppendInput extends AiAuditJournalBatch {
  workspaceId: string;
  expectedRevision: number;
  createdAt: string;
}

export interface AiAuditJournalEntry extends AiAuditJournalBatch {
  workspaceId: string;
  sequence: number;
  createdAt: string;
}

export interface BrowserWorkspaceStore {
  getDurability(): "persistent" | "memory" | "unknown";
  put(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotMetadata>;
  get(workspaceId: string): Promise<WorkspaceSnapshot | undefined>;
  getState(workspaceId: string): Promise<WorkspaceStorageState | undefined>;
  list(): Promise<WorkspaceSnapshotMetadata[]>;
  delete(workspaceId: string): Promise<void>;
  rename(workspaceId: string, nextWorkspaceId: string): Promise<void>;
  appendAiAuditJournal(
    input: AiAuditJournalAppendInput,
  ): Promise<AiAuditJournalEntry>;
  readAiAuditJournal(
    workspaceId: string,
    expectedRevision?: number,
  ): Promise<AiAuditJournalEntry[]>;
  getAiAuditJournalHighWatermark(
    workspaceId: string,
    expectedRevision: number,
  ): Promise<number>;
}

export interface WorkspaceTombstone {
  workspaceId: string;
  revision: number;
  schemaVersion: number;
  updatedAt: string;
  size: 0;
  deleted: true;
}

type WorkspaceMemoryRecord = WorkspaceSnapshot | WorkspaceTombstone;
export type WorkspaceStorageState = WorkspaceMemoryRecord;

function isWorkspaceTombstone(
  record: WorkspaceSnapshotMetadata | WorkspaceTombstone,
): record is WorkspaceTombstone {
  return "deleted" in record && record.deleted;
}

function tombstoneFor(
  workspaceId: string,
  current?: Pick<WorkspaceSnapshotMetadata, "revision" | "schemaVersion">,
): WorkspaceTombstone {
  return {
    workspaceId,
    revision: (current?.revision ?? 0) + 1,
    schemaVersion: current?.schemaVersion ?? 1,
    updatedAt: new Date().toISOString(),
    size: 0,
    deleted: true,
  };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function metadataFor(input: WorkspaceSnapshotInput): WorkspaceSnapshotMetadata {
  return {
    workspaceId: input.workspaceId,
    revision: input.revision,
    schemaVersion: input.schemaVersion,
    updatedAt: input.updatedAt,
    size: input.bytes.byteLength,
  };
}

function staleWorkspaceRevisionError(): BrowserWorkspaceError {
  return new BrowserWorkspaceError(
    "stale-write",
    "A newer workspace snapshot already exists",
  );
}

function assertWorkspaceRevision(
  current: MetadataRecord | WorkspaceMemoryRecord | undefined,
  expectedRevision: number,
): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new BrowserWorkspaceError(
      "storage-failed",
      "The expected workspace revision is invalid",
    );
  }
  if ((current?.revision ?? 0) !== expectedRevision) {
    throw staleWorkspaceRevisionError();
  }
}

export async function computeAiAuditJournalBatchId(
  appendArgsJson: string,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(appendArgsJson),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function assertAiAuditJournalBatchIntegrity(
  input: AiAuditJournalBatch,
): Promise<void> {
  if (
    typeof input.batchId !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.batchId) ||
    typeof input.appendArgsJson !== "string" ||
    !input.appendArgsJson
  ) {
    throw new BrowserWorkspaceError(
      "storage-failed",
      "The AI audit journal batch is invalid",
    );
  }
  const expectedBatchId = await computeAiAuditJournalBatchId(
    input.appendArgsJson,
  );
  if (input.batchId !== expectedBatchId) {
    throw new BrowserWorkspaceError(
      "storage-failed",
      "The AI audit journal batchId does not match appendArgsJson",
    );
  }
}

function copyJournalEntry(entry: AiAuditJournalEntry): AiAuditJournalEntry {
  return { ...entry };
}

export function createMemoryWorkspaceStore(): BrowserWorkspaceStore {
  const snapshots = new Map<string, WorkspaceMemoryRecord>();
  const auditJournal = new Map<string, AiAuditJournalEntry[]>();
  const auditJournalHighWatermarks = new Map<string, number>();
  const getState = (workspaceId: string): WorkspaceStorageState | undefined => {
    const state = snapshots.get(workspaceId);
    if (!state) return undefined;
    return isWorkspaceTombstone(state)
      ? { ...state }
      : { ...state, bytes: copyBytes(state.bytes) };
  };
  return {
    getDurability: () => "memory",
    async put(input) {
      const current = snapshots.get(input.workspaceId);
      if (current && input.revision <= current.revision) {
        throw staleWorkspaceRevisionError();
      }
      const metadata = metadataFor(input);
      snapshots.set(input.workspaceId, {
        ...metadata,
        bytes: copyBytes(input.bytes),
      });
      const watermark = input.auditJournalCompactionWatermark;
      if (watermark !== undefined) {
        auditJournal.set(
          input.workspaceId,
          (auditJournal.get(input.workspaceId) ?? []).filter(
            (entry) => entry.sequence > watermark,
          ),
        );
      }
      return metadata;
    },
    async get(workspaceId) {
      const state = getState(workspaceId);
      return state && !isWorkspaceTombstone(state) ? state : undefined;
    },
    async getState(workspaceId) {
      return getState(workspaceId);
    },
    async list() {
      return [...snapshots.values()]
        .filter(
          (snapshot): snapshot is WorkspaceSnapshot =>
            !isWorkspaceTombstone(snapshot),
        )
        .map(({ bytes: _bytes, ...metadata }) => metadata)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async delete(workspaceId) {
      const current = snapshots.get(workspaceId);
      snapshots.set(workspaceId, tombstoneFor(workspaceId, current));
      auditJournal.delete(workspaceId);
      auditJournalHighWatermarks.delete(workspaceId);
    },
    async rename(workspaceId, nextWorkspaceId) {
      const current = snapshots.get(workspaceId);
      if (!current || isWorkspaceTombstone(current)) return;
      const existing = snapshots.get(nextWorkspaceId);
      if (existing && !isWorkspaceTombstone(existing)) {
        throw new BrowserWorkspaceError(
          "stale-write",
          "The destination workspace already exists",
        );
      }
      const nextRevision = existing
        ? Math.max(current.revision, existing.revision + 1)
        : current.revision;
      snapshots.set(nextWorkspaceId, {
        ...current,
        workspaceId: nextWorkspaceId,
        revision: nextRevision,
        bytes: copyBytes(current.bytes),
      });
      snapshots.set(workspaceId, tombstoneFor(workspaceId, current));
      const sourceJournal = auditJournal.get(workspaceId) ?? [];
      auditJournal.delete(nextWorkspaceId);
      if (sourceJournal.length > 0) {
        auditJournal.set(
          nextWorkspaceId,
          sourceJournal.map((entry) => ({
            ...entry,
            workspaceId: nextWorkspaceId,
          })),
        );
      }
      auditJournal.delete(workspaceId);
      const sourceHighWatermark = auditJournalHighWatermarks.get(workspaceId);
      auditJournalHighWatermarks.delete(nextWorkspaceId);
      if (sourceHighWatermark !== undefined) {
        auditJournalHighWatermarks.set(nextWorkspaceId, sourceHighWatermark);
      }
      auditJournalHighWatermarks.delete(workspaceId);
    },
    async appendAiAuditJournal(input) {
      await assertAiAuditJournalBatchIntegrity(input);
      assertWorkspaceRevision(
        snapshots.get(input.workspaceId),
        input.expectedRevision,
      );
      const entries = auditJournal.get(input.workspaceId) ?? [];
      const existing = entries.find((entry) => entry.batchId === input.batchId);
      if (existing) {
        if (existing.appendArgsJson !== input.appendArgsJson) {
          throw new BrowserWorkspaceError(
            "storage-failed",
            "AI audit journal digest collision",
          );
        }
        return copyJournalEntry(existing);
      }
      const sequence =
        (auditJournalHighWatermarks.get(input.workspaceId) ?? 0) + 1;
      const entry: AiAuditJournalEntry = {
        workspaceId: input.workspaceId,
        sequence,
        batchId: input.batchId,
        appendArgsJson: input.appendArgsJson,
        createdAt: input.createdAt,
      };
      auditJournal.set(input.workspaceId, [...entries, entry]);
      auditJournalHighWatermarks.set(input.workspaceId, sequence);
      return copyJournalEntry(entry);
    },
    async readAiAuditJournal(workspaceId, expectedRevision) {
      if (expectedRevision !== undefined) {
        assertWorkspaceRevision(snapshots.get(workspaceId), expectedRevision);
      }
      const entries = (auditJournal.get(workspaceId) ?? []).map(
        copyJournalEntry,
      );
      await Promise.all(entries.map(assertAiAuditJournalBatchIntegrity));
      return entries;
    },
    async getAiAuditJournalHighWatermark(workspaceId, expectedRevision) {
      assertWorkspaceRevision(snapshots.get(workspaceId), expectedRevision);
      return auditJournal.get(workspaceId)?.at(-1)?.sequence ?? 0;
    },
  };
}

function canFailOverFromPrimary(cause: unknown): boolean {
  return (
    cause instanceof BrowserWorkspaceError &&
    (cause.code === "unavailable" || cause.code === "storage-failed")
  );
}

/**
 * Fall back only when the primary store cannot complete its first operation.
 * Once it has succeeded, switching stores would hide already-persisted data.
 */
export function createFailoverWorkspaceStore(
  primary: BrowserWorkspaceStore,
  fallback: BrowserWorkspaceStore,
): BrowserWorkspaceStore {
  let active: BrowserWorkspaceStore | null = null;
  let selectionPromise: Promise<BrowserWorkspaceStore> | null = null;

  const run = async <T>(
    operation: (store: BrowserWorkspaceStore) => Promise<T>,
  ): Promise<T> => {
    if (active) return operation(active);
    if (selectionPromise) return operation(await selectionPromise);

    let selectStore: (store: BrowserWorkspaceStore) => void = () => undefined;
    selectionPromise = new Promise((resolve) => {
      selectStore = resolve;
    });
    try {
      const result = await operation(primary);
      active = primary;
      selectStore(primary);
      return result;
    } catch (cause) {
      if (!canFailOverFromPrimary(cause)) {
        active = primary;
        selectStore(primary);
        throw cause;
      }
      active = fallback;
      selectStore(fallback);
      return operation(fallback);
    }
  };

  return {
    getDurability: () => active?.getDurability() ?? "unknown",
    put: (input) => run((store) => store.put(input)),
    get: (workspaceId) => run((store) => store.get(workspaceId)),
    getState: (workspaceId) => run((store) => store.getState(workspaceId)),
    list: () => run((store) => store.list()),
    delete: (workspaceId) => run((store) => store.delete(workspaceId)),
    rename: (workspaceId, nextWorkspaceId) =>
      run((store) => store.rename(workspaceId, nextWorkspaceId)),
    appendAiAuditJournal: (input) =>
      run((store) => store.appendAiAuditJournal(input)),
    readAiAuditJournal: (workspaceId, expectedRevision) =>
      run((store) => store.readAiAuditJournal(workspaceId, expectedRevision)),
    getAiAuditJournalHighWatermark: (workspaceId, expectedRevision) =>
      run((store) =>
        store.getAiAuditJournalHighWatermark(workspaceId, expectedRevision),
      ),
  };
}

type MetadataRecord = WorkspaceSnapshotMetadata | WorkspaceTombstone;
interface BlobRecord {
  workspaceId: string;
  revision: number;
  bytes: ArrayBuffer;
}

interface AuditJournalStateRecord {
  workspaceId: string;
  highWaterSequence: number;
}

const METADATA_STORE = "workspace_metadata";
const BLOB_STORE = "workspace_blobs";
const AUDIT_JOURNAL_STORE = "workspace_ai_audit_journal";
const AUDIT_JOURNAL_STATE_STORE = "workspace_ai_audit_journal_state";
const AUDIT_JOURNAL_BATCH_INDEX = "workspace_batch_id";
const INDEXED_DB_SCHEMA_VERSION = 2;

function auditJournalRange(
  workspaceId: string,
  highWaterSequence = Number.MAX_SAFE_INTEGER,
): IDBKeyRange {
  return IDBKeyRange.bound([workspaceId, 0], [workspaceId, highWaterSequence]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function toStorageError(cause: unknown): BrowserWorkspaceError {
  if (cause instanceof BrowserWorkspaceError) return cause;
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "QuotaExceededError") {
    return new BrowserWorkspaceError(
      "quota-exceeded",
      "Browser storage is full",
    );
  }
  return new BrowserWorkspaceError(
    "storage-failed",
    "Browser workspace storage failed",
  );
}

export interface IndexedDbWorkspaceStoreOptions {
  dbName?: string;
  indexedDB?: IDBFactory;
}

export function createIndexedDbWorkspaceStore(
  options: IndexedDbWorkspaceStoreOptions = {},
): BrowserWorkspaceStore {
  const indexedDb = options.indexedDB ?? globalThis.indexedDB;
  const dbName = options.dbName ?? "grimodex-browser-workspaces";
  if (!indexedDb) {
    throw new BrowserWorkspaceError(
      "unavailable",
      "IndexedDB is not available in this runtime",
    );
  }
  let databasePromise: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDb.open(dbName, INDEXED_DB_SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(METADATA_STORE)) {
          database.createObjectStore(METADATA_STORE, {
            keyPath: "workspaceId",
          });
        }
        if (!database.objectStoreNames.contains(BLOB_STORE)) {
          database.createObjectStore(BLOB_STORE, {
            keyPath: ["workspaceId", "revision"],
          });
        }
        const journalStore = database.objectStoreNames.contains(
          AUDIT_JOURNAL_STORE,
        )
          ? request.transaction!.objectStore(AUDIT_JOURNAL_STORE)
          : database.createObjectStore(AUDIT_JOURNAL_STORE, {
              keyPath: ["workspaceId", "sequence"],
            });
        if (!journalStore.indexNames.contains(AUDIT_JOURNAL_BATCH_INDEX)) {
          journalStore.createIndex(
            AUDIT_JOURNAL_BATCH_INDEX,
            ["workspaceId", "batchId"],
            { unique: true },
          );
        }
        if (!database.objectStoreNames.contains(AUDIT_JOURNAL_STATE_STORE)) {
          database.createObjectStore(AUDIT_JOURNAL_STATE_STORE, {
            keyPath: "workspaceId",
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(toStorageError(request.error));
    });
    return databasePromise;
  };

  const getState = async (
    workspaceId: string,
  ): Promise<WorkspaceStorageState | undefined> => {
    try {
      const database = await open();
      return await new Promise<WorkspaceStorageState | undefined>(
        (resolve, reject) => {
          const transaction = database.transaction(
            [METADATA_STORE, BLOB_STORE],
            "readonly",
          );
          const metadataRequest = transaction
            .objectStore(METADATA_STORE)
            .get(workspaceId);
          let result: WorkspaceStorageState | undefined;
          let failure: unknown;
          metadataRequest.onerror = () => {
            failure = metadataRequest.error;
            transaction.abort();
          };
          metadataRequest.onsuccess = () => {
            const metadata = metadataRequest.result as
              | MetadataRecord
              | undefined;
            if (!metadata) return;
            if (isWorkspaceTombstone(metadata)) {
              result = metadata;
              return;
            }
            const blobRequest = transaction
              .objectStore(BLOB_STORE)
              .get([workspaceId, metadata.revision]);
            blobRequest.onerror = () => {
              failure = blobRequest.error;
              transaction.abort();
            };
            blobRequest.onsuccess = () => {
              const blob = blobRequest.result as BlobRecord | undefined;
              if (!blob) {
                failure = new BrowserWorkspaceError(
                  "storage-failed",
                  "The workspace snapshot blob is missing",
                );
                transaction.abort();
                return;
              }
              result = { ...metadata, bytes: new Uint8Array(blob.bytes) };
            };
          };
          transaction.oncomplete = () => {
            if (failure) reject(failure);
            else resolve(result);
          };
          transaction.onerror = () => reject(failure ?? transaction.error);
          transaction.onabort = () => reject(failure ?? transaction.error);
        },
      );
    } catch (cause) {
      throw toStorageError(cause);
    }
  };

  return {
    getDurability: () => "persistent",
    async put(input) {
      try {
        if (
          input.auditJournalCompactionWatermark !== undefined &&
          (!Number.isSafeInteger(input.auditJournalCompactionWatermark) ||
            input.auditJournalCompactionWatermark < 0)
        ) {
          throw new BrowserWorkspaceError(
            "storage-failed",
            "The AI audit journal compaction watermark is invalid",
          );
        }
        const database = await open();
        const metadata = metadataFor(input);
        return await new Promise<WorkspaceSnapshotMetadata>(
          (resolve, reject) => {
            const storeNames = [METADATA_STORE, BLOB_STORE];
            if (input.auditJournalCompactionWatermark !== undefined) {
              storeNames.push(AUDIT_JOURNAL_STORE);
            }
            const transaction = database.transaction(storeNames, "readwrite");
            const metadataStore = transaction.objectStore(METADATA_STORE);
            const blobStore = transaction.objectStore(BLOB_STORE);
            let failure: BrowserWorkspaceError | null = null;
            const currentRequest = metadataStore.get(input.workspaceId);
            currentRequest.onsuccess = () => {
              const current = currentRequest.result as
                | MetadataRecord
                | undefined;
              if (current && input.revision <= current.revision) {
                failure = new BrowserWorkspaceError(
                  "stale-write",
                  "A newer workspace snapshot already exists",
                );
                transaction.abort();
                return;
              }
              if (input.auditJournalCompactionWatermark !== undefined) {
                transaction
                  .objectStore(AUDIT_JOURNAL_STORE)
                  .delete(
                    auditJournalRange(
                      input.workspaceId,
                      input.auditJournalCompactionWatermark,
                    ),
                  );
              }
              const bytes = input.bytes.slice().buffer;
              blobStore.put({
                workspaceId: input.workspaceId,
                revision: input.revision,
                bytes,
              } satisfies BlobRecord);
              metadataStore.put(metadata satisfies MetadataRecord);
              if (current && current.revision !== input.revision) {
                blobStore.delete([input.workspaceId, current.revision]);
              }
            };
            transaction.oncomplete = () => resolve(metadata);
            transaction.onerror = () =>
              reject(failure ?? toStorageError(transaction.error));
            transaction.onabort = () =>
              reject(failure ?? toStorageError(transaction.error));
          },
        );
      } catch (cause) {
        throw toStorageError(cause);
      }
    },
    async get(workspaceId) {
      const state = await getState(workspaceId);
      return state && !isWorkspaceTombstone(state) ? state : undefined;
    },
    async getState(workspaceId) {
      return getState(workspaceId);
    },
    async list() {
      try {
        const database = await open();
        const transaction = database.transaction(METADATA_STORE, "readonly");
        const values = (await requestResult(
          transaction.objectStore(METADATA_STORE).getAll(),
        )) as MetadataRecord[];
        return values
          .filter(
            (metadata): metadata is WorkspaceSnapshotMetadata =>
              !isWorkspaceTombstone(metadata),
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      } catch (cause) {
        throw toStorageError(cause);
      }
    },
    async appendAiAuditJournal(input) {
      try {
        await assertAiAuditJournalBatchIntegrity(input);
        const database = await open();
        return await new Promise<AiAuditJournalEntry>((resolve, reject) => {
          const transaction = database.transaction(
            [METADATA_STORE, AUDIT_JOURNAL_STORE, AUDIT_JOURNAL_STATE_STORE],
            "readwrite",
          );
          const metadataStore = transaction.objectStore(METADATA_STORE);
          const journalStore = transaction.objectStore(AUDIT_JOURNAL_STORE);
          const stateStore = transaction.objectStore(AUDIT_JOURNAL_STATE_STORE);
          let result: AiAuditJournalEntry | null = null;
          let failure: BrowserWorkspaceError | null = null;
          const abortWith = (error: BrowserWorkspaceError) => {
            failure = error;
            transaction.abort();
          };
          const metadataRequest = metadataStore.get(input.workspaceId);
          metadataRequest.onsuccess = () => {
            try {
              assertWorkspaceRevision(
                metadataRequest.result as MetadataRecord | undefined,
                input.expectedRevision,
              );
            } catch (cause) {
              abortWith(toStorageError(cause));
              return;
            }
            const existingRequest = journalStore
              .index(AUDIT_JOURNAL_BATCH_INDEX)
              .get([input.workspaceId, input.batchId]);
            existingRequest.onsuccess = () => {
              const existing = existingRequest.result as
                | AiAuditJournalEntry
                | undefined;
              if (existing) {
                if (existing.appendArgsJson !== input.appendArgsJson) {
                  abortWith(
                    new BrowserWorkspaceError(
                      "storage-failed",
                      "AI audit journal digest collision",
                    ),
                  );
                  return;
                }
                result = copyJournalEntry(existing);
                return;
              }
              const stateRequest = stateStore.get(input.workspaceId);
              stateRequest.onsuccess = () => {
                const state = stateRequest.result as
                  | AuditJournalStateRecord
                  | undefined;
                const sequence = (state?.highWaterSequence ?? 0) + 1;
                if (!Number.isSafeInteger(sequence)) {
                  abortWith(
                    new BrowserWorkspaceError(
                      "storage-failed",
                      "AI audit journal sequence is exhausted",
                    ),
                  );
                  return;
                }
                result = {
                  workspaceId: input.workspaceId,
                  sequence,
                  batchId: input.batchId,
                  appendArgsJson: input.appendArgsJson,
                  createdAt: input.createdAt,
                };
                journalStore.put(result);
                stateStore.put({
                  workspaceId: input.workspaceId,
                  highWaterSequence: sequence,
                } satisfies AuditJournalStateRecord);
              };
            };
          };
          transaction.oncomplete = () => {
            if (result) resolve(copyJournalEntry(result));
            else {
              reject(
                new BrowserWorkspaceError(
                  "storage-failed",
                  "AI audit journal append completed without a record",
                ),
              );
            }
          };
          transaction.onerror = () =>
            reject(failure ?? toStorageError(transaction.error));
          transaction.onabort = () =>
            reject(failure ?? toStorageError(transaction.error));
        });
      } catch (cause) {
        throw toStorageError(cause);
      }
    },
    async readAiAuditJournal(workspaceId, expectedRevision) {
      try {
        const database = await open();
        const entries = await new Promise<AiAuditJournalEntry[]>(
          (resolve, reject) => {
            const transaction = database.transaction(
              [METADATA_STORE, AUDIT_JOURNAL_STORE],
              "readonly",
            );
            let entries: AiAuditJournalEntry[] = [];
            let failure: BrowserWorkspaceError | null = null;
            if (expectedRevision !== undefined) {
              const metadataRequest = transaction
                .objectStore(METADATA_STORE)
                .get(workspaceId);
              metadataRequest.onsuccess = () => {
                try {
                  assertWorkspaceRevision(
                    metadataRequest.result as MetadataRecord | undefined,
                    expectedRevision,
                  );
                } catch (cause) {
                  failure = toStorageError(cause);
                  transaction.abort();
                }
              };
            }
            const journalRequest = transaction
              .objectStore(AUDIT_JOURNAL_STORE)
              .getAll(auditJournalRange(workspaceId));
            journalRequest.onsuccess = () => {
              entries = (journalRequest.result as AiAuditJournalEntry[]).map(
                copyJournalEntry,
              );
            };
            transaction.oncomplete = () => resolve(entries);
            transaction.onerror = () =>
              reject(failure ?? toStorageError(transaction.error));
            transaction.onabort = () =>
              reject(failure ?? toStorageError(transaction.error));
          },
        );
        await Promise.all(entries.map(assertAiAuditJournalBatchIntegrity));
        return entries;
      } catch (cause) {
        throw toStorageError(cause);
      }
    },
    async getAiAuditJournalHighWatermark(workspaceId, expectedRevision) {
      try {
        const database = await open();
        return await new Promise<number>((resolve, reject) => {
          const transaction = database.transaction(
            [METADATA_STORE, AUDIT_JOURNAL_STORE],
            "readonly",
          );
          let highWaterSequence = 0;
          let failure: BrowserWorkspaceError | null = null;
          const metadataRequest = transaction
            .objectStore(METADATA_STORE)
            .get(workspaceId);
          metadataRequest.onsuccess = () => {
            try {
              assertWorkspaceRevision(
                metadataRequest.result as MetadataRecord | undefined,
                expectedRevision,
              );
            } catch (cause) {
              failure = toStorageError(cause);
              transaction.abort();
            }
          };
          const tailRequest = transaction
            .objectStore(AUDIT_JOURNAL_STORE)
            .openCursor(auditJournalRange(workspaceId), "prev");
          tailRequest.onsuccess = () => {
            const entry = tailRequest.result?.value as
              | AiAuditJournalEntry
              | undefined;
            highWaterSequence = entry?.sequence ?? 0;
          };
          transaction.oncomplete = () => resolve(highWaterSequence);
          transaction.onerror = () =>
            reject(failure ?? toStorageError(transaction.error));
          transaction.onabort = () =>
            reject(failure ?? toStorageError(transaction.error));
        });
      } catch (cause) {
        throw toStorageError(cause);
      }
    },
    async delete(workspaceId) {
      try {
        const database = await open();
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(
            [
              METADATA_STORE,
              BLOB_STORE,
              AUDIT_JOURNAL_STORE,
              AUDIT_JOURNAL_STATE_STORE,
            ],
            "readwrite",
          );
          const metadataStore = transaction.objectStore(METADATA_STORE);
          const blobStore = transaction.objectStore(BLOB_STORE);
          const journalStore = transaction.objectStore(AUDIT_JOURNAL_STORE);
          const journalStateStore = transaction.objectStore(
            AUDIT_JOURNAL_STATE_STORE,
          );
          const currentRequest = metadataStore.get(workspaceId);
          currentRequest.onsuccess = () => {
            const current = currentRequest.result as MetadataRecord | undefined;
            metadataStore.put(tombstoneFor(workspaceId, current));
          };
          const keysRequest = blobStore.getAllKeys();
          keysRequest.onsuccess = () => {
            for (const key of keysRequest.result) {
              if (Array.isArray(key) && key[0] === workspaceId)
                blobStore.delete(key);
            }
          };
          journalStore.delete(auditJournalRange(workspaceId));
          journalStateStore.delete(workspaceId);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () =>
            reject(transaction.error ?? new Error("IndexedDB delete failed"));
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("IndexedDB delete aborted"));
        });
      } catch (cause) {
        throw toStorageError(cause);
      }
    },
    async rename(workspaceId, nextWorkspaceId) {
      if (workspaceId === nextWorkspaceId) return;
      try {
        const database = await open();
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(
            [
              METADATA_STORE,
              BLOB_STORE,
              AUDIT_JOURNAL_STORE,
              AUDIT_JOURNAL_STATE_STORE,
            ],
            "readwrite",
          );
          const metadataStore = transaction.objectStore(METADATA_STORE);
          const blobStore = transaction.objectStore(BLOB_STORE);
          const journalStore = transaction.objectStore(AUDIT_JOURNAL_STORE);
          const journalStateStore = transaction.objectStore(
            AUDIT_JOURNAL_STATE_STORE,
          );
          let failure: BrowserWorkspaceError | null = null;
          const abortWith = (error: BrowserWorkspaceError) => {
            failure = error;
            transaction.abort();
          };
          const currentRequest = metadataStore.get(workspaceId);
          currentRequest.onerror = () =>
            abortWith(toStorageError(currentRequest.error));
          currentRequest.onsuccess = () => {
            const current = currentRequest.result as MetadataRecord | undefined;
            if (!current || isWorkspaceTombstone(current)) return;
            const destinationRequest = metadataStore.get(nextWorkspaceId);
            destinationRequest.onerror = () =>
              abortWith(toStorageError(destinationRequest.error));
            destinationRequest.onsuccess = () => {
              const destination = destinationRequest.result as
                | MetadataRecord
                | undefined;
              if (destination && !isWorkspaceTombstone(destination)) {
                abortWith(
                  new BrowserWorkspaceError(
                    "stale-write",
                    "The destination workspace already exists",
                  ),
                );
                return;
              }
              const nextRevision = destination
                ? Math.max(current.revision, destination.revision + 1)
                : current.revision;
              const blobRequest = blobStore.get([
                workspaceId,
                current.revision,
              ]);
              blobRequest.onerror = () =>
                abortWith(toStorageError(blobRequest.error));
              blobRequest.onsuccess = () => {
                const blob = blobRequest.result as BlobRecord | undefined;
                if (!blob) {
                  abortWith(
                    new BrowserWorkspaceError(
                      "storage-failed",
                      "The workspace snapshot blob is missing",
                    ),
                  );
                  return;
                }
                blobStore.put({
                  workspaceId: nextWorkspaceId,
                  revision: nextRevision,
                  bytes: blob.bytes,
                });
                metadataStore.put({
                  ...current,
                  workspaceId: nextWorkspaceId,
                  revision: nextRevision,
                });
                metadataStore.put(tombstoneFor(workspaceId, current));
                blobStore.delete([workspaceId, current.revision]);
                journalStore.delete(auditJournalRange(nextWorkspaceId));
                journalStateStore.delete(nextWorkspaceId);
                const journalRequest = journalStore.getAll(
                  auditJournalRange(workspaceId),
                );
                journalRequest.onsuccess = () => {
                  for (const entry of journalRequest.result as AiAuditJournalEntry[]) {
                    journalStore.put({
                      ...entry,
                      workspaceId: nextWorkspaceId,
                    } satisfies AiAuditJournalEntry);
                  }
                  journalStore.delete(auditJournalRange(workspaceId));
                };
                const stateRequest = journalStateStore.get(workspaceId);
                stateRequest.onsuccess = () => {
                  const state = stateRequest.result as
                    | AuditJournalStateRecord
                    | undefined;
                  if (state) {
                    journalStateStore.put({
                      ...state,
                      workspaceId: nextWorkspaceId,
                    } satisfies AuditJournalStateRecord);
                  }
                  journalStateStore.delete(workspaceId);
                };
              };
            };
          };
          transaction.oncomplete = () => resolve();
          transaction.onerror = () =>
            reject(failure ?? toStorageError(transaction.error));
          transaction.onabort = () =>
            reject(failure ?? toStorageError(transaction.error));
        });
      } catch (cause) {
        throw toStorageError(cause);
      }
    },
  };
}
