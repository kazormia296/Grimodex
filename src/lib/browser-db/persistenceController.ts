import {
  BrowserWorkspaceError,
  type AiAuditJournalBatch,
  type AiAuditJournalEntry,
  type BrowserWorkspaceStore,
  type WorkspaceSnapshot,
} from "./indexedDbStore";

export interface PersistenceControllerOptions {
  store: BrowserWorkspaceStore;
  workspaceId: string;
  schemaVersion?: number;
  debounceMs?: number;
  exportDatabase: () => Promise<Uint8Array>;
  now?: () => string;
  onError?: (error: unknown) => void;
}

export interface PersistenceController {
  markDirty(): void;
  flush(): Promise<void>;
  /**
   * Explicit snapshot flush that rejects a retained stale-write conflict.
   * Audit pre-dispatch persistence uses acknowledgeAiAuditBatch instead.
   */
  flushStrict(): Promise<void>;
  acknowledgeAiAuditBatch(batch: AiAuditJournalBatch): Promise<void>;
  loadAiAuditJournal(): Promise<AiAuditJournalEntry[]>;
  whenIdle(): Promise<void>;
  restore(): Promise<WorkspaceSnapshot | undefined>;
  attachLifecycle(target?: Window): () => void;
  isBlockedByConflict(): boolean;
}

export function createPersistenceController(
  options: PersistenceControllerOptions,
): PersistenceController {
  const debounceMs = options.debounceMs ?? 2_000;
  const now = options.now ?? (() => new Date().toISOString());
  let revision = 0;
  let dirtyGeneration = 0;
  let persistedGeneration = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<void> = Promise.resolve();
  let blockedByConflict = false;
  let blockedConflictCause: unknown = null;

  const writeSnapshot = async (
    snapshotRevision: number,
    auditJournalCompactionWatermark: number,
  ): Promise<void> => {
    const bytes = await options.exportDatabase();
    await options.store.put({
      workspaceId: options.workspaceId,
      revision: snapshotRevision,
      schemaVersion: options.schemaVersion ?? 1,
      updatedAt: now(),
      bytes,
      auditJournalCompactionWatermark,
    });
  };

  const retainedConflict = (): unknown =>
    blockedConflictCause ??
    new BrowserWorkspaceError(
      "stale-write",
      "Browser workspace persistence is blocked by a stale-write conflict",
    );

  const blockOnStaleWrite = (cause: unknown): void => {
    if (
      cause instanceof BrowserWorkspaceError &&
      cause.code === "stale-write"
    ) {
      blockedByConflict = true;
      blockedConflictCause = cause;
    }
  };

  const runFlush = async (strict: boolean): Promise<void> => {
    if (blockedByConflict) {
      if (strict) throw retainedConflict();
      return;
    }
    const generationAtStart = dirtyGeneration;
    const nextRevision = revision + 1;
    try {
      // Capture this before export. An append that commits after export starts
      // receives a higher sequence and must remain replayable after this put.
      const auditJournalCompactionWatermark =
        await options.store.getAiAuditJournalHighWatermark(
          options.workspaceId,
          revision,
        );
      if (
        dirtyGeneration === persistedGeneration &&
        auditJournalCompactionWatermark === 0
      ) {
        return;
      }
      await writeSnapshot(nextRevision, auditJournalCompactionWatermark);
      revision = nextRevision;
    } catch (cause) {
      if (
        !(cause instanceof BrowserWorkspaceError) ||
        cause.code !== "stale-write"
      ) {
        throw cause;
      }
      const latest = await options.store.getState(options.workspaceId);
      revision = latest?.revision ?? 0;
      // A stale write means another tab has newer application state. Do not
      // promote this tab's old in-memory export to a newer revision: doing so
      // would silently overwrite the other tab. Stop until the caller restores
      // (or explicitly resolves) the conflict.
      blockOnStaleWrite(cause);
      throw cause;
    }
    if (generationAtStart === dirtyGeneration)
      persistedGeneration = generationAtStart;
  };

  const enqueueOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      (cause) => {
        options.onError?.(cause);
        return undefined;
      },
    );
    return result;
  };

  const enqueueFlush = (strict: boolean): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return enqueueOperation(() => runFlush(strict));
  };
  const flush = (): Promise<void> => enqueueFlush(false);
  const flushStrict = (): Promise<void> => enqueueFlush(true);

  return {
    markDirty() {
      dirtyGeneration += 1;
      if (blockedByConflict) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void flush().catch(() => undefined);
      }, debounceMs);
    },
    flush,
    flushStrict,
    acknowledgeAiAuditBatch(batch) {
      return enqueueOperation(async () => {
        if (blockedByConflict) throw retainedConflict();
        try {
          await options.store.appendAiAuditJournal({
            workspaceId: options.workspaceId,
            expectedRevision: revision,
            createdAt: now(),
            ...batch,
          });
        } catch (cause) {
          blockOnStaleWrite(cause);
          throw cause;
        }
      });
    },
    loadAiAuditJournal() {
      return enqueueOperation(async () => {
        if (blockedByConflict) throw retainedConflict();
        try {
          return await options.store.readAiAuditJournal(
            options.workspaceId,
            revision,
          );
        } catch (cause) {
          blockOnStaleWrite(cause);
          throw cause;
        }
      });
    },
    whenIdle: () => queue,
    async restore() {
      const state = await options.store.getState(options.workspaceId);
      if (state) revision = state.revision;
      blockedByConflict = false;
      blockedConflictCause = null;
      return state && !("deleted" in state) ? state : undefined;
    },
    attachLifecycle(
      target = typeof window === "undefined" ? undefined : window,
    ) {
      if (!target) return () => undefined;
      const flushOnLifecycle = () => {
        void flush().catch(() => undefined);
      };
      const onVisibilityChange = () => {
        if (target.document.visibilityState === "hidden") flushOnLifecycle();
      };
      target.addEventListener("pagehide", flushOnLifecycle);
      target.document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        target.removeEventListener("pagehide", flushOnLifecycle);
        target.document.removeEventListener(
          "visibilitychange",
          onVisibilityChange,
        );
      };
    },
    isBlockedByConflict: () => blockedByConflict,
  };
}
