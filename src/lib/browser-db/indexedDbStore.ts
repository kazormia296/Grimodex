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

export interface BrowserWorkspaceStore {
  getDurability(): "persistent" | "memory" | "unknown";
  put(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotMetadata>;
  get(workspaceId: string): Promise<WorkspaceSnapshot | undefined>;
  getState(workspaceId: string): Promise<WorkspaceStorageState | undefined>;
  list(): Promise<WorkspaceSnapshotMetadata[]>;
  delete(workspaceId: string): Promise<void>;
  rename(workspaceId: string, nextWorkspaceId: string): Promise<void>;
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

export function createMemoryWorkspaceStore(): BrowserWorkspaceStore {
  const snapshots = new Map<string, WorkspaceMemoryRecord>();
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
        throw new BrowserWorkspaceError(
          "stale-write",
          "A newer workspace snapshot already exists",
        );
      }
      const metadata = metadataFor(input);
      snapshots.set(input.workspaceId, {
        ...metadata,
        bytes: copyBytes(input.bytes),
      });
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
  };
}

type MetadataRecord = WorkspaceSnapshotMetadata | WorkspaceTombstone;
interface BlobRecord {
  workspaceId: string;
  revision: number;
  bytes: ArrayBuffer;
}

const METADATA_STORE = "workspace_metadata";
const BLOB_STORE = "workspace_blobs";

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
      const request = indexedDb.open(dbName, 1);
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
        const database = await open();
        const metadata = metadataFor(input);
        return await new Promise<WorkspaceSnapshotMetadata>(
          (resolve, reject) => {
            const transaction = database.transaction(
              [METADATA_STORE, BLOB_STORE],
              "readwrite",
            );
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
    async delete(workspaceId) {
      try {
        const database = await open();
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(
            [METADATA_STORE, BLOB_STORE],
            "readwrite",
          );
          const metadataStore = transaction.objectStore(METADATA_STORE);
          const blobStore = transaction.objectStore(BLOB_STORE);
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
            [METADATA_STORE, BLOB_STORE],
            "readwrite",
          );
          const metadataStore = transaction.objectStore(METADATA_STORE);
          const blobStore = transaction.objectStore(BLOB_STORE);
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
