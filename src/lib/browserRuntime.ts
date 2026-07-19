import {
  parseEditorSeed,
  type HostedAiSessionV1,
  type EditorSeedValidationResult,
  type EditorUiLanguage,
} from "@grimodex/scan-contract";
import { applyScanImportPlan } from "@/features/import/scan/applyScanImportPlan";
import { createScanImportOperationsForPlan } from "@/features/import/scan/scanImportOperations";
import { buildScanImportPlan } from "@/features/import/scan/scanImportPlan";
import { consumeEditorSeedHandoff } from "@/features/import/scan/webEditorHandoff";
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
import { createHostedBrowserAi } from "./hostedBrowserAi";
import { globalSettingsRepository } from "./globalSettings/repository";
import i18next from "./i18n";
import { installBrowserMock } from "./tauri";

export const HOSTED_EDITOR_WORKSPACE_ID = "grimodex-hosted-editor";
export const HOSTED_AI_SESSION_STORAGE_KEY = "grimodex:hosted-ai-session/v1";
export const HOSTED_EDITOR_ENTRY_MODE_STORAGE_KEY =
  "grimodex:hosted-editor-entry-mode/v1";
const BROWSER_WORKSPACE_LOCK_PREFIX = "grimodex:browser-workspace:";
const DEFAULT_SCAN_API_BASE_URL =
  "https://grimodex-scan-production.kazormia296.workers.dev";

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

type ScanImportPlan = ReturnType<typeof buildScanImportPlan>;
type ScanImportOperations = ReturnType<
  typeof createScanImportOperationsForPlan
>;
type ScanImportResult = Awaited<ReturnType<typeof applyScanImportPlan>>;

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
  consumeEditorSeedHandoff: typeof consumeEditorSeedHandoff;
  parseEditorSeed(input: unknown): EditorSeedValidationResult;
  buildScanImportPlan(input: unknown): ScanImportPlan;
  createScanImportOperationsForPlan(plan: ScanImportPlan): ScanImportOperations;
  applyScanImportPlan(
    plan: ScanImportPlan,
    operations: ScanImportOperations,
  ): Promise<ScanImportResult>;
  applyUiLanguage(language: EditorUiLanguage): Promise<void>;
  resolveUiLanguage(
    fallback?: EditorUiLanguage,
  ): EditorUiLanguage | undefined | Promise<EditorUiLanguage | undefined>;
}

async function applyBrowserUiLanguage(
  language: EditorUiLanguage,
): Promise<void> {
  await globalSettingsRepository.patch((current) => ({
    ...current,
    uiLanguage: language,
  }));
  await i18next.changeLanguage(language);
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
}

function normalizeEditorUiLanguage(
  value: string | undefined,
): EditorUiLanguage | undefined {
  if (!value) return undefined;
  if (value === "ja" || value.startsWith("ja-")) return "ja";
  if (value === "en" || value.startsWith("en-")) return "en";
  return undefined;
}

async function resolveBrowserUiLanguage(
  fallback?: EditorUiLanguage,
): Promise<EditorUiLanguage | undefined> {
  try {
    const settings = await globalSettingsRepository.read();
    const persisted = normalizeEditorUiLanguage(settings.uiLanguage);
    if (persisted) return persisted;
  } catch {
    // Fall through to the active renderer language while browser storage is
    // temporarily unavailable during startup or recovery.
  }
  return (
    normalizeEditorUiLanguage(i18next.resolvedLanguage ?? i18next.language) ??
    fallback
  );
}

const DEFAULT_DEPENDENCIES: BrowserRuntimeDependencies = {
  createBrowserMock,
  installBrowserMock: (mock) =>
    installBrowserMock(mock as PersistentBrowserMock),
  consumeEditorSeedHandoff,
  parseEditorSeed,
  buildScanImportPlan,
  createScanImportOperationsForPlan,
  applyScanImportPlan,
  applyUiLanguage: applyBrowserUiLanguage,
  resolveUiLanguage: resolveBrowserUiLanguage,
};

export interface HostedEditorWorkspaceStoreOptions {
  indexedDB?: IDBFactory | null;
  dbName?: string;
}

export function createHostedEditorWorkspaceStore(
  options: HostedEditorWorkspaceStoreOptions = {},
): BrowserWorkspaceStore {
  const indexedDb =
    options.indexedDB === undefined
      ? (globalThis.indexedDB ?? null)
      : options.indexedDB;
  if (!indexedDb) {
    throw new BrowserWorkspaceError(
      "unavailable",
      "このブラウザーではIndexedDBを利用できないため、Grimodex Editorを安全に起動できません。",
    );
  }
  return createIndexedDbWorkspaceStore({
    indexedDB: indexedDb,
    dbName: options.dbName,
  });
}

export interface InitializeBrowserRuntimeOptions {
  workspaceId?: string;
  store?: BrowserWorkspaceStore;
  href?: string;
  scanApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  replaceHistory?: (href: string) => void;
  lifecycleTarget?: Window | null;
  sessionStorage?: BrowserSessionStorage | null;
  lockManager?: Pick<LockManager, "request"> | null;
  debounceMs?: number;
  onPersistenceError?: (error: unknown) => void;
  dependencies?: BrowserRuntimeDependencies;
}

export interface BrowserSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HostedBrowserRuntime {
  workspaceId: string;
  durability: ReturnType<BrowserWorkspaceStore["getDurability"]>;
  persistence: PersistenceController;
  entryMode: HostedEditorEntryMode;
  importedProjectId?: string;
  exportWorkspace(): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

export type HostedEditorEntryMode = "scan" | "standalone";

function readHostedEditorEntryMode(
  storage: BrowserSessionStorage | null,
): HostedEditorEntryMode | undefined {
  try {
    const value = storage?.getItem(HOSTED_EDITOR_ENTRY_MODE_STORAGE_KEY);
    return value === "scan" || value === "standalone" ? value : undefined;
  } catch {
    return undefined;
  }
}

function persistHostedEditorEntryMode(
  storage: BrowserSessionStorage | null,
  entryMode: HostedEditorEntryMode,
): void {
  try {
    storage?.setItem(HOSTED_EDITOR_ENTRY_MODE_STORAGE_KEY, entryMode);
  } catch {
    // A restricted tab can still run safely; only the explanatory label falls
    // back to standalone after a reload.
  }
}

export function assertHostedEditorDurability(
  durability: HostedBrowserRuntime["durability"],
): void {
  if (durability === "persistent") return;
  throw new BrowserWorkspaceError(
    "unavailable",
    "永続保存を確認できないため、Grimodex Editorを起動できません。ブラウザーのサイトデータ設定を確認してください。",
  );
}

function browserHref(): string {
  return typeof window === "undefined"
    ? "http://localhost/editor"
    : window.location.href;
}

function browserFetch(): typeof fetch {
  return globalThis.fetch.bind(globalThis);
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
      (cause) => {
        rejectAcquired(cause);
      },
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

type StoredHostedAiSession = HostedAiSessionV1 & {
  uiLanguage?: EditorUiLanguage;
};

function isHostedAiSession(value: unknown): value is StoredHostedAiSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.scanId === "string" &&
    /^[A-Za-z0-9._:-]{1,96}$/.test(session.scanId) &&
    typeof session.token === "string" &&
    /^[a-f0-9]{64}$/.test(session.token) &&
    typeof session.expiresAt === "string" &&
    Number.isFinite(Date.parse(session.expiresAt)) &&
    (session.uiLanguage === undefined ||
      session.uiLanguage === "ja" ||
      session.uiLanguage === "en")
  );
}

function readHostedAiSession(
  storage: BrowserSessionStorage | null,
): StoredHostedAiSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(HOSTED_AI_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as unknown;
    if (
      !isHostedAiSession(session) ||
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      storage.removeItem(HOSTED_AI_SESSION_STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    try {
      storage.removeItem(HOSTED_AI_SESSION_STORAGE_KEY);
    } catch {
      // Storage can be disabled by the browser.
    }
    return null;
  }
}

function persistHostedAiSession(
  storage: BrowserSessionStorage | null,
  session: HostedAiSessionV1,
  uiLanguage?: EditorUiLanguage,
): void {
  if (!storage || Date.parse(session.expiresAt) <= Date.now()) return;
  try {
    storage.setItem(
      HOSTED_AI_SESSION_STORAGE_KEY,
      JSON.stringify(uiLanguage ? { ...session, uiLanguage } : session),
    );
  } catch {
    // A live handoff still works in memory when sessionStorage is unavailable.
  }
}

function configuredScanApiBaseUrl(): string {
  const configured = (
    import.meta.env as Record<string, string | boolean | undefined>
  ).VITE_SCAN_API_BASE_URL;
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : import.meta.env.DEV
      ? "http://127.0.0.1:8787"
      : DEFAULT_SCAN_API_BASE_URL;
}

function invalidSeedMessage(
  result: Extract<EditorSeedValidationResult, { ok: false }>,
): string {
  return `Scan editor seed is invalid: ${result.errors
    .map((item) => `${item.path} ${item.message}`)
    .join("; ")}`;
}

/**
 * Prepares the real hosted Editor before React mounts. Database calls made by
 * App therefore always use the restored SQL.js database, never the lazy demo
 * fallback in the IPC adapter.
 */
export async function initializeBrowserRuntime(
  options: InitializeBrowserRuntimeOptions = {},
): Promise<HostedBrowserRuntime> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const workspaceId = options.workspaceId ?? HOSTED_EDITOR_WORKSPACE_ID;
  const store = options.store ?? createHostedEditorWorkspaceStore();
  if (!options.store) assertHostedEditorDurability(store.getDurability());
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
    const handoff = await dependencies.consumeEditorSeedHandoff({
      href: options.href ?? browserHref(),
      apiBaseUrl: options.scanApiBaseUrl ?? configuredScanApiBaseUrl(),
      fetchImpl: options.fetchImpl ?? browserFetch(),
      replaceHistory: options.replaceHistory ?? replaceBrowserHistory,
    });
    let parsedSeed: unknown = null;
    if (handoff) {
      const parsed = dependencies.parseEditorSeed(handoff.seed);
      if (!parsed.ok) throw new Error(invalidSeedMessage(parsed));
      parsedSeed = parsed.value;
    }
    const sessionStorage =
      options.sessionStorage === undefined
        ? browserSessionStorage()
        : options.sessionStorage;
    const entryMode: HostedEditorEntryMode = handoff
      ? "scan"
      : (readHostedEditorEntryMode(sessionStorage) ?? "standalone");
    persistHostedEditorEntryMode(sessionStorage, entryMode);
    const storedHostedAiSession = readHostedAiSession(sessionStorage);
    const hostedAiSession = handoff?.hostedAiSession ?? storedHostedAiSession;
    const hostedAiLocale = handoff?.hostedAiSession
      ? handoff.uiLanguage
      : storedHostedAiSession?.uiLanguage;
    if (handoff?.hostedAiSession) {
      persistHostedAiSession(
        sessionStorage,
        handoff.hostedAiSession,
        handoff.uiLanguage,
      );
    }
    const hostedAi = hostedAiSession
      ? createHostedBrowserAi({
          apiBaseUrl: options.scanApiBaseUrl ?? configuredScanApiBaseUrl(),
          session: hostedAiSession,
          locale: hostedAiLocale,
          getLocale: () => dependencies.resolveUiLanguage(hostedAiLocale),
          fetchImpl: options.fetchImpl ?? browserFetch(),
        })
      : null;

    database = await dependencies.createBrowserMock({
      databaseBytes: restored?.bytes,
      onDatabaseDirty: () => persistence.markDirty(),
      ...(hostedAi
        ? {
            aiSettingsOverride: {
              provider: "openrouter" as const,
              model: "grimodex-hosted",
              thinkingEnabled: false,
            },
            authorizeAiRequest: hostedAi.authorizeAiRequest,
            aiTransport: hostedAi.transport,
            aiTransportProvidesProviderAccess: true,
          }
        : {}),
    });

    dependencies.installBrowserMock(database);
    const target =
      options.lifecycleTarget === undefined
        ? browserLifecycleTarget()
        : options.lifecycleTarget;
    if (target) detachLifecycle = persistence.attachLifecycle(target);

    let importedProjectId: string | undefined;
    if (parsedSeed) {
      const plan = dependencies.buildScanImportPlan(parsedSeed);
      const result = await dependencies.applyScanImportPlan(
        plan,
        dependencies.createScanImportOperationsForPlan(plan),
      );
      importedProjectId = result.projectId;
      if (handoff?.uiLanguage) {
        await dependencies.applyUiLanguage(handoff.uiLanguage);
      }
      // The import operations normally mark the database dirty themselves.
      // This explicit mark also protects future operation adapters that batch
      // or defer their writes.
      persistence.markDirty();
      await persistence.flush();
    }

    return {
      workspaceId,
      durability: store.getDurability(),
      persistence,
      entryMode,
      importedProjectId,
      async exportWorkspace() {
        await persistence.flush();
        if (!database) {
          throw new Error("Browser database is not ready");
        }
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
