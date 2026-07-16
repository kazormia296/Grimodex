import {
  BrowserWorkspaceError,
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

  const writeSnapshot = async (snapshotRevision: number): Promise<void> => {
    const bytes = await options.exportDatabase();
    await options.store.put({
      workspaceId: options.workspaceId,
      revision: snapshotRevision,
      schemaVersion: options.schemaVersion ?? 1,
      updatedAt: now(),
      bytes,
    });
  };

  const runFlush = async (): Promise<void> => {
    if (blockedByConflict || dirtyGeneration === persistedGeneration) return;
    const generationAtStart = dirtyGeneration;
    const nextRevision = revision + 1;
    try {
      await writeSnapshot(nextRevision);
      revision = nextRevision;
    } catch (cause) {
      if (
        !(cause instanceof BrowserWorkspaceError) ||
        cause.code !== "stale-write"
      ) {
        throw cause;
      }
      const latest = await options.store.get(options.workspaceId);
      revision = latest?.revision ?? 0;
      // A stale write means another tab has newer application state. Do not
      // promote this tab's old in-memory export to a newer revision: doing so
      // would silently overwrite the other tab. Stop until the caller restores
      // (or explicitly resolves) the conflict.
      blockedByConflict = true;
      throw cause;
    }
    if (generationAtStart === dirtyGeneration)
      persistedGeneration = generationAtStart;
  };

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const operation = queue.then(runFlush, runFlush);
    queue = operation.catch((cause) => {
      options.onError?.(cause);
      return undefined;
    });
    return operation;
  };

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
    whenIdle: () => queue,
    async restore() {
      const state = await options.store.getState(options.workspaceId);
      if (state) revision = state.revision;
      blockedByConflict = false;
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
