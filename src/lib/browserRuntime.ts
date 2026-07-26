import {
  BrowserWorkspaceError,
  createIndexedDbWorkspaceStore,
  type BrowserWorkspaceStore,
} from "./browser-db/indexedDbStore";
import {
  createPersistenceController,
  type PersistenceController,
} from "./browser-db/persistenceController";
import {
  createBrowserMock,
  type BrowserMockOptions,
  type PersistentBrowserMock,
} from "./browser-mock";
import { installBrowserMock } from "./tauri";

// Preserve the existing workspace key so removing Scan never strands or
// silently deletes manuscripts already saved by a Web Editor trial.
export const WEB_EDITOR_WORKSPACE_ID = "grimodex-hosted-editor";

// These constants identify state written by removed Scan/Hosted AI builds.
// Startup only clears them; no value is parsed, restored, or sent anywhere.
export const HOSTED_AI_SESSION_STORAGE_KEY = "grimodex:hosted-ai-session/v1";
export const HOSTED_EDITOR_ENTRY_MODE_STORAGE_KEY =
  "grimodex:hosted-editor-entry-mode/v1";

// WebLLM used these exact, origin-scoped Cache Storage names. Keep this
// narrowly targeted retirement list so upgrades remove downloaded model
// artifacts without touching the workspace or any unrelated browser cache.
export const RETIRED_BROWSER_MODEL_CACHE_NAMES = [
  "webllm/model",
  "webllm/config",
  "webllm/wasm",
] as const;

const BROWSER_WORKSPACE_LOCK_PREFIX = "grimodex:browser-workspace:";

export type BrowserWorkspaceLockErrorCode =
  | "unsupported"
  | "already-open"
  | "acquisition-failed";

export class BrowserWorkspaceLockError extends Error {
  readonly code: BrowserWorkspaceLockErrorCode;

  constructor(
    code: BrowserWorkspaceLockErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrowserWorkspaceLockError";
    this.code = code;
  }
}

interface BrowserWorkspaceLockLease {
  release(): Promise<void>;
}

/** The runtime only needs the persistent surface of BrowserMock. */
export interface BrowserRuntimeDatabase {
  exportDatabase(): Uint8Array;
  close(): void;
}

export interface BrowserRuntimeDependencies {
  createBrowserMock(
    options: BrowserMockOptions,
  ): Promise<BrowserRuntimeDatabase>;
  installBrowserMock(mock: BrowserRuntimeDatabase): void;
}

const DEFAULT_DEPENDENCIES: BrowserRuntimeDependencies = {
  createBrowserMock,
  installBrowserMock: (mock) =>
    installBrowserMock(mock as PersistentBrowserMock),
};

export interface WebEditorWorkspaceStoreOptions {
  indexedDB?: IDBFactory | null;
  dbName?: string;
}

export function createWebEditorWorkspaceStore(
  options: WebEditorWorkspaceStoreOptions = {},
): BrowserWorkspaceStore {
  const indexedDb =
    options.indexedDB === undefined
      ? (globalThis.indexedDB ?? null)
      : options.indexedDB;
  if (!indexedDb) {
    throw new BrowserWorkspaceError(
      "unavailable",
      "このブラウザーではIndexedDBを利用できないため、Grimodex Web Editorを安全に起動できません。",
    );
  }
  return createIndexedDbWorkspaceStore({
    indexedDB: indexedDb,
    dbName: options.dbName,
  });
}

export interface BrowserSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface InitializeBrowserRuntimeOptions {
  workspaceId?: string;
  store?: BrowserWorkspaceStore;
  /** Legacy URL is inspected only to remove the retired Scan fragment. */
  href?: string;
  /** @deprecated Scan endpoints are no longer contacted. */
  scanApiBaseUrl?: string;
  /** @deprecated Retained as a compatibility seam; never invoked. */
  fetchImpl?: typeof fetch;
  replaceHistory?: (href: string) => void;
  lifecycleTarget?: Window | null;
  sessionStorage?: BrowserSessionStorage | null;
  cacheStorage?: Pick<CacheStorage, "delete"> | null;
  lockManager?: Pick<LockManager, "request"> | null;
  debounceMs?: number;
  onPersistenceError?: (error: unknown) => void;
  dependencies?: BrowserRuntimeDependencies;
}

export interface WebEditorBrowserRuntime {
  workspaceId: string;
  durability: ReturnType<BrowserWorkspaceStore["getDurability"]>;
  persistence: PersistenceController;
  exportWorkspace(): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

export function assertWebEditorDurability(
  durability: WebEditorBrowserRuntime["durability"],
): void {
  if (durability === "persistent") return;
  throw new BrowserWorkspaceError(
    "unavailable",
    "永続保存を確認できないため、Grimodex Web Editorを起動できません。ブラウザーのサイトデータ設定を確認してください。",
  );
}

function browserHref(): string {
  return typeof window === "undefined"
    ? "http://localhost/editor"
    : window.location.href;
}

function replaceBrowserHistory(href: string): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(window.history.state, "", href);
}

function browserLifecycleTarget(): Window | null {
  return typeof window === "undefined" ? null : window;
}

function browserSessionStorage(): BrowserSessionStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function browserLockManager(): Pick<LockManager, "request"> | null {
  try {
    if (typeof navigator === "undefined") return null;
    return (
      (
        navigator as Navigator & {
          locks?: Pick<LockManager, "request">;
        }
      ).locks ?? null
    );
  } catch {
    return null;
  }
}

function browserCacheStorage(): Pick<CacheStorage, "delete"> | null {
  try {
    return typeof caches === "undefined" ? null : caches;
  } catch {
    return null;
  }
}

export async function clearRetiredBrowserModelCaches(
  cacheStorage: Pick<CacheStorage, "delete"> | null,
): Promise<void> {
  if (!cacheStorage) return;
  await Promise.allSettled(
    RETIRED_BROWSER_MODEL_CACHE_NAMES.map((cacheName) =>
      Promise.resolve().then(() => cacheStorage.delete(cacheName)),
    ),
  );
}

function clearLegacyHostedState(options: {
  href: string;
  replaceHistory: (href: string) => void;
  sessionStorage: BrowserSessionStorage | null;
}): void {
  try {
    options.sessionStorage?.removeItem(HOSTED_AI_SESSION_STORAGE_KEY);
    options.sessionStorage?.removeItem(HOSTED_EDITOR_ENTRY_MODE_STORAGE_KEY);
  } catch {
    // Restricted storage must not block the editor-only startup path.
  }

  try {
    const url = new URL(options.href);
    if (!url.hash.toLowerCase().includes("scan-import")) return;
    url.hash = "";
    options.replaceHistory(url.toString());
  } catch {
    // A malformed legacy URL is ignored. It is never fetched or persisted.
  }
}

async function acquireBrowserWorkspaceLock(
  workspaceId: string,
  lockManager: Pick<LockManager, "request"> | null,
): Promise<BrowserWorkspaceLockLease> {
  if (!lockManager) {
    throw new BrowserWorkspaceLockError(
      "unsupported",
      "このブラウザーは安全な複数タブ制御に対応していません。Web Locks API 対応ブラウザーで開いてください。",
    );
  }

  let resolveAcquired!: (acquired: boolean) => void;
  let rejectAcquired!: (cause: unknown) => void;
  const acquired = new Promise<boolean>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  let releaseHeldLock!: () => void;
  const holdLock = new Promise<void>((resolve) => {
    releaseHeldLock = resolve;
  });
  const lockName = `${BROWSER_WORKSPACE_LOCK_PREFIX}${workspaceId}`;

  const requestCompletion = Promise.resolve()
    .then(() =>
      lockManager.request(
        lockName,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            resolveAcquired(false);
            return;
          }
          resolveAcquired(true);
          await holdLock;
        },
      ),
    )
    .then(
      () => undefined,
      (cause) => rejectAcquired(cause),
    );

  let lockWasAcquired: boolean;
  try {
    lockWasAcquired = await acquired;
  } catch (cause) {
    await requestCompletion;
    throw new BrowserWorkspaceLockError(
      "acquisition-failed",
      "このブラウザーでワークスペースの安全な排他制御を開始できませんでした。ページを再読み込みしてください。",
      { cause },
    );
  }

  if (!lockWasAcquired) {
    await requestCompletion;
    throw new BrowserWorkspaceLockError(
      "already-open",
      "このワークスペースは別のタブで開かれています。データの上書きを防ぐため、先に開いているタブを閉じてから再読み込みしてください。",
    );
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      releaseHeldLock();
      await requestCompletion;
    },
  };
}

export function browserPersistenceFailureMessage(error: unknown): string {
  if (error instanceof BrowserWorkspaceError) {
    if (error.code === "stale-write") {
      return "別のタブまたは古いEditorとの保存競合を検出したため、自動保存を停止しました。このタブでは編集を続けず、ほかのEditorタブを閉じてから再読み込みしてください。";
    }
    if (error.code === "quota-exceeded") {
      return "ブラウザーの保存容量が不足したため、自動保存を停止しました。空き容量を確保してから再読み込みしてください。";
    }
  }
  return "ブラウザーへの自動保存に失敗しました。未保存の内容を保護するため、このタブでは編集を続けず、ページを再読み込みしてください。";
}

/**
 * Restores and installs the real Web Editor database before React mounts.
 * This path has no upload, hosted session, provider credential, or network
 * bootstrap. AI remains disconnected until the user configures Local LLM or
 * supplies their own provider key in the editor.
 */
export async function initializeBrowserRuntime(
  options: InitializeBrowserRuntimeOptions = {},
): Promise<WebEditorBrowserRuntime> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const workspaceId = options.workspaceId ?? WEB_EDITOR_WORKSPACE_ID;
  const store = options.store ?? createWebEditorWorkspaceStore();
  if (!options.store) assertWebEditorDurability(store.getDurability());

  const sessionStorage =
    options.sessionStorage === undefined
      ? browserSessionStorage()
      : options.sessionStorage;
  clearLegacyHostedState({
    href: options.href ?? browserHref(),
    replaceHistory: options.replaceHistory ?? replaceBrowserHistory,
    sessionStorage,
  });
  await clearRetiredBrowserModelCaches(
    options.cacheStorage === undefined
      ? browserCacheStorage()
      : options.cacheStorage,
  );

  const workspaceLock = await acquireBrowserWorkspaceLock(
    workspaceId,
    options.lockManager === undefined
      ? browserLockManager()
      : options.lockManager,
  );
  let database: BrowserRuntimeDatabase | null = null;
  const persistence = createPersistenceController({
    store,
    workspaceId,
    debounceMs: options.debounceMs,
    exportDatabase: async () => {
      if (!database) throw new Error("Browser database is not ready");
      return database.exportDatabase();
    },
    onError:
      options.onPersistenceError ??
      ((error) => console.error("[browser-runtime] persistence failed", error)),
  });
  let detachLifecycle: () => void = () => undefined;

  try {
    const restored = await persistence.restore();
    database = await dependencies.createBrowserMock({
      databaseBytes: restored?.bytes,
      onDatabaseDirty: () => persistence.markDirty(),
    });
    dependencies.installBrowserMock(database);

    const target =
      options.lifecycleTarget === undefined
        ? browserLifecycleTarget()
        : options.lifecycleTarget;
    if (target) detachLifecycle = persistence.attachLifecycle(target);

    return {
      workspaceId,
      durability: store.getDurability(),
      persistence,
      async exportWorkspace() {
        await persistence.flush();
        if (!database) throw new Error("Browser database is not ready");
        return new Uint8Array(database.exportDatabase());
      },
      async dispose() {
        detachLifecycle();
        try {
          await persistence.flush();
        } finally {
          database?.close();
          database = null;
          await workspaceLock.release();
        }
      },
    };
  } catch (error) {
    detachLifecycle();
    database?.close();
    await workspaceLock.release().catch((releaseError) => {
      console.error(
        "[browser-runtime] workspace lock release failed",
        releaseError,
      );
    });
    throw error;
  }
}

/** @deprecated Use WebEditorBrowserRuntime. */
export type HostedBrowserRuntime = WebEditorBrowserRuntime;
