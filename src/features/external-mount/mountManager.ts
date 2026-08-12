import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { announce } from "@/lib/a11y/announcer";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { compareInstantValues } from "@/lib/time";
import { countSceneBodyCharsFromJson } from "@/features/editor/charCountForBody";
import { getProjectSetting, setProjectSetting } from "@/features/settings/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  createNode,
  deleteNode,
  listAllNodes,
  listExpiredArchivedNodeIds,
  loadSceneContent,
  loadSceneContents,
  saveSceneContent,
  updateNode,
} from "@/features/tree/api";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { rebaselineScenesAtTail } from "@/features/timelapse/toggle";
import { useTreeStore } from "@/features/tree/treeStore";
import { generateNKeysBetween } from "@/features/tree/fractionalIndex";
import { scheduleSceneIndex } from "@/features/semantic-search/scheduler";
import { useChatStore } from "@/features/chat/chatStore";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useTabStore } from "@/features/editor/tabStore";
import { getPersistedActiveSceneId } from "@/features/editor/tabPersistence";
import {
  discardRegisteredDocumentDrafts,
  hasRetainedRecoveryDraftForDocument,
} from "@/features/editor/editorSaveRegistry";
import { runExclusiveDocumentMutation } from "@/features/editor/document/documentSaveCoordinator";
import {
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import { awaitPendingSceneContentWrite } from "@/features/tree/pendingSceneWrites";
import {
  canScheduleQuiescenceMutation,
  isQuiescenceLeaseActive,
  schedulePreexistingParticipantMutation,
  waitForQuiescenceMutationAdmission,
} from "@/application/lifecycle/quiescenceLease";
import {
  discardAutoSavesForDocument,
  hasPendingOrFailedAutoSaveForDocument,
} from "@/hooks/useAutoSave";
import * as mountApi from "./api";
import { useExternalRootStore } from "./externalRootStore";
import { markdownToPmJson, pmJsonToMarkdown } from "./markdownBridge";
import { contentHash } from "./contentHash";
import {
  basename,
  buildMountFolderUri,
  buildSourceUri,
  dirname,
  parseSourceUri,
  titleFromFilename,
} from "./sourceUri";
import type { ExternalRoot, FileEvent, ScanResult, ScannedFile } from "./types";
import { EXTERNAL_ROOTS_KEY } from "./types";
import { cancelWriteBack, hasPendingWriteBack } from "./writeBack";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { scheduleBodyMentionScan } from "@/features/editor/persistSceneBody";
import { publishExternalDocumentReload } from "@/lib/externalDocumentReloadRegistry";
import { runTreeTopologyMutation } from "@/application/tree/treeTopologyMutationRegistry";

const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RENAME_WINDOW_MS = 5000;

interface RecentDelete {
  rootId: string;
  relPath: string;
  contentHash: string;
  at: number;
}

const recentDeletes: RecentDelete[] = [];

interface PendingArchive {
  rootId: string;
  relPath: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingArchives: PendingArchive[] = [];
interface TrackedFileEvent {
  readonly keys: ReadonlySet<string>;
  readonly isAuthorityCurrent: MountAuthorityGuard;
  readonly observedDuringNarrativeSnapshot: boolean;
  admitted: boolean;
  permitUnderQuiescence: boolean;
  readonly permitSignal: Promise<void>;
  readonly grantQuiescencePermit: () => void;
}

function createTrackedFileEvent(
  keys: ReadonlySet<string>,
  isAuthorityCurrent: MountAuthorityGuard,
  observedDuringNarrativeSnapshot: boolean,
): TrackedFileEvent {
  let resolvePermit!: () => void;
  let permitGranted = false;
  const permitSignal = new Promise<void>((resolve) => {
    resolvePermit = resolve;
  });
  const tracked: TrackedFileEvent = {
    keys,
    isAuthorityCurrent,
    observedDuringNarrativeSnapshot,
    admitted: false,
    permitUnderQuiescence: false,
    permitSignal,
    grantQuiescencePermit: () => {
      if (permitGranted) return;
      permitGranted = true;
      tracked.permitUnderQuiescence = true;
      resolvePermit();
    },
  };
  return tracked;
}

const activeFileEvents = new Map<Promise<void>, TrackedFileEvent>();
const fileEventRootChains = new Map<string, Promise<void>>();
interface FailedFileEvent {
  readonly error: unknown;
  readonly revision: number;
  readonly isAuthorityCurrent: MountAuthorityGuard;
}

const failedFileEvents = new Map<string, FailedFileEvent>();
let fileEventFailureRevision = 0;
const MAX_FILE_EVENT_DRAIN_ROUNDS = 50;

function rootFileEventChainKey(rootId: string, authorityToken: number): string {
  return `${rootId}\u0000${authorityToken}`;
}

function beginRootFileEvent<T>(
  rootId: string,
  authorityToken: number,
  operation: () => Promise<T>,
): Promise<T> {
  const chainKey = rootFileEventChainKey(rootId, authorityToken);
  const previous = fileEventRootChains.get(chainKey);
  return previous ? previous.then(operation) : operation();
}

function extendRootFileEventChain(
  rootId: string,
  authorityToken: number,
  completedTask: Promise<unknown>,
): void {
  const chainKey = rootFileEventChainKey(rootId, authorityToken);
  const tail = completedTask.then(
    () => undefined,
    () => undefined,
  );
  fileEventRootChains.set(chainKey, tail);
  void tail.finally(() => {
    if (fileEventRootChains.get(chainKey) === tail) {
      fileEventRootChains.delete(chainKey);
    }
  });
}

function externalPathKey(rootId: string, relPath: string): string {
  return `${rootId}\u0000${relPath}`;
}

function externalRootWideKey(rootId: string): string {
  return `${rootId}\u0000\u0000`;
}

function rootWideKeyForPathKey(pathKey: string): string {
  const separator = pathKey.indexOf("\u0000");
  return externalRootWideKey(pathKey.slice(0, separator));
}

function keysAffectTargets(
  keys: ReadonlySet<string>,
  targets: ReadonlySet<string>,
): boolean {
  for (const key of keys) {
    if (targets.has(key)) return true;
    const keySeparator = key.indexOf("\u0000");
    const keyRootId = key.slice(0, keySeparator);
    const keyRelPath = key.slice(keySeparator + 1);
    for (const target of targets) {
      if (rootWideKeyForPathKey(target) !== externalRootWideKey(keyRootId)) {
        continue;
      }
      if (key === externalRootWideKey(keyRootId)) return true;
      const targetRelPath = target.slice(target.indexOf("\u0000") + 1);
      if (
        targetRelPath === ".mount" ||
        keyRelPath.startsWith(`${targetRelPath.replace(/\/+$/, "")}/`)
      ) {
        return true;
      }
    }
  }
  return false;
}

function sourceUriPathKey(sourceUri: string): string | null {
  const parsed = parseSourceUri(sourceUri);
  return parsed ? externalPathKey(parsed.rootId, parsed.relPath) : null;
}

export function hasExternalMountReloadConflictForScene(
  sceneId: string,
): boolean {
  return useExternalRootStore
    .getState()
    .conflicts.some((conflict) => conflict.sceneId === sceneId);
}

function eventPathKeys(event: FileEvent): ReadonlySet<string> {
  const keys = new Set([externalPathKey(event.rootId, event.relPath)]);
  if (event.oldRelPath) {
    keys.add(externalPathKey(event.rootId, event.oldRelPath));
  }
  return keys;
}

function recordFileEventFailure(
  keys: ReadonlySet<string>,
  error: unknown,
  isAuthorityCurrent: MountAuthorityGuard,
): void {
  if (!isAuthorityCurrent()) return;
  fileEventFailureRevision += 1;
  const failure = {
    error,
    revision: fileEventFailureRevision,
    isAuthorityCurrent,
  };
  for (const key of keys) failedFileEvents.set(key, failure);
}

function clearFileEventFailures(
  keys: ReadonlySet<string>,
  throughRevision = Number.POSITIVE_INFINITY,
): void {
  for (const key of keys) {
    const failure = failedFileEvents.get(key);
    if (failure && failure.revision <= throughRevision) {
      failedFileEvents.delete(key);
    }
  }
}

function clearFileEventFailuresForRoot(
  rootId: string,
  throughRevision = Number.POSITIVE_INFINITY,
): void {
  const prefix = `${rootId}\u0000`;
  for (const [key, failure] of failedFileEvents) {
    if (key.startsWith(prefix) && failure.revision <= throughRevision) {
      failedFileEvents.delete(key);
    }
  }
}

function cancelPendingArchive(rootId: string, relPath: string): void {
  const idx = pendingArchives.findIndex(
    (p) => p.rootId === rootId && p.relPath === relPath,
  );
  if (idx === -1) return;
  clearTimeout(pendingArchives[idx].timer);
  pendingArchives.splice(idx, 1);
}

/** @internal test helper */
export function _resetPendingArchives(): void {
  for (const p of pendingArchives) clearTimeout(p.timer);
  pendingArchives.length = 0;
}

export interface ExternalMountSourceExpectation {
  readonly sourceUri: string;
  /** Omit during preflight when the DB may legitimately be ahead of write-back. */
  readonly content?: string;
}

async function verifyExternalMountSourcesOnDisk(
  targets: ReadonlySet<string>,
  expectations: readonly ExternalMountSourceExpectation[],
): Promise<void> {
  const expectedByUri = new Map<string, ExternalMountSourceExpectation>();
  for (const expectation of expectations) {
    if (expectedByUri.has(expectation.sourceUri)) {
      throw new Error(
        `Multiple persisted Scenes share an external source: ${expectation.sourceUri}`,
      );
    }
    expectedByUri.set(expectation.sourceUri, expectation);
  }
  const targetsByRoot = new Map<
    string,
    Array<{ key: string; relPath: string }>
  >();
  for (const key of targets) {
    const separator = key.indexOf("\u0000");
    const rootId = key.slice(0, separator);
    const relPath = key.slice(separator + 1);
    targetsByRoot.set(rootId, [
      ...(targetsByRoot.get(rootId) ?? []),
      { key, relPath },
    ]);
  }

  for (const [rootId, rootTargets] of targetsByRoot) {
    const scan = await mountApi.scanMount(rootId);
    const filesByPath = new Map(scan.files.map((file) => [file.relPath, file]));
    const directoryPaths = new Set(scan.dirs.map((dir) => dir.relPath));
    for (const target of rootTargets) {
      const sourceUri = buildSourceUri(rootId, target.relPath);
      const expectation = expectedByUri.get(sourceUri);
      if (expectation) {
        const file = filesByPath.get(target.relPath);
        if (!file) throw new Error(`External source is missing: ${sourceUri}`);
        if (expectation.content === undefined) continue;
        const [diskHash, persistedHash] = await Promise.all([
          hashForDiskContent(file.content),
          hashForNode({ content: expectation.content }),
        ]);
        if (!persistedHash || diskHash !== persistedHash) {
          throw new Error(
            `External source differs from its persisted Scene: ${sourceUri}`,
          );
        }
        continue;
      }

      if (target.relPath === ".mount") {
        for (const file of scan.files) {
          if (!expectedByUri.has(buildSourceUri(rootId, file.relPath))) {
            throw new Error(
              `External mount contains an unpersisted source: ${file.relPath}`,
            );
          }
        }
        continue;
      }
      if (!directoryPaths.has(target.relPath)) {
        throw new Error(`External source path is missing: ${sourceUri}`);
      }
      const descendantPrefix = `${target.relPath.replace(/\/+$/, "")}/`;
      for (const file of scan.files) {
        if (
          file.relPath.startsWith(descendantPrefix) &&
          !expectedByUri.has(buildSourceUri(rootId, file.relPath))
        ) {
          throw new Error(
            `External folder contains an unpersisted source: ${file.relPath}`,
          );
        }
      }
    }
  }
}

/** Wait for pre-existing watcher work touching the selected source files. */
export async function settleExternalMountMutationsForSourceUris(
  sourceUris: readonly string[],
  expectations?: readonly ExternalMountSourceExpectation[],
): Promise<void> {
  const targets = new Set<string>();
  for (const sourceUri of sourceUris) {
    const key = sourceUriPathKey(sourceUri);
    if (!key) throw new Error(`External source URI is invalid: ${sourceUri}`);
    targets.add(key);
  }
  if (targets.size === 0) return;
  const targetRoots = new Set(
    [...targets].map((target) => rootWideKeyForPathKey(target)),
  );

  for (let round = 0; round < MAX_FILE_EVENT_DRAIN_ROUNDS; round += 1) {
    const active = [...activeFileEvents.entries()]
      .filter(([, tracked]) => tracked.isAuthorityCurrent())
      .map(([task, tracked], index) => ({
        task,
        tracked,
        index,
        affectsTargets: keysAffectTargets(tracked.keys, targets),
        roots: new Set(
          [...tracked.keys].map((key) => rootWideKeyForPathKey(key)),
        ),
      }));
    const lastMatchingIndexByRoot = new Map<string, number>();
    for (const entry of active) {
      if (!entry.affectsTargets) continue;
      for (const root of entry.roots) {
        if (targetRoots.has(root))
          lastMatchingIndexByRoot.set(root, entry.index);
      }
    }
    const pending = active.filter((entry) =>
      [...entry.roots].some(
        (root) =>
          targetRoots.has(root) &&
          entry.index <= (lastMatchingIndexByRoot.get(root) ?? -1),
      ),
    );
    if (pending.length > 0) {
      if (
        pending.some(
          ({ tracked, affectsTargets }) =>
            affectsTargets && tracked.observedDuringNarrativeSnapshot,
        )
      ) {
        throw new Error(
          "An external source changed during narrative snapshot creation",
        );
      }
      for (const { tracked } of pending) {
        tracked.grantQuiescencePermit();
      }
      const failures = (
        await Promise.all(
          pending.map(async ({ task, tracked, affectsTargets }) => {
            try {
              await task;
              return undefined;
            } catch (error) {
              return affectsTargets && tracked.isAuthorityCurrent()
                ? error
                : undefined;
            }
          }),
        )
      ).filter((error) => error !== undefined);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "One or more external source mutations failed",
        );
      }
      continue;
    }

    const stickyFailures = [
      ...new Set(
        [...failedFileEvents.entries()]
          .filter(
            ([key, failure]) =>
              failure.isAuthorityCurrent() &&
              keysAffectTargets(new Set([key]), targets),
          )
          .map(([, failure]) => failure),
      ),
    ];
    if (stickyFailures.length > 0) {
      throw new AggregateError(
        stickyFailures.map((failure) => failure.error),
        "One or more external source mutations previously failed",
      );
    }

    const archivePending = pendingArchives.some((archive) =>
      keysAffectTargets(
        new Set([externalPathKey(archive.rootId, archive.relPath)]),
        targets,
      ),
    );
    if (archivePending) {
      throw new Error(
        "An external source removal is still inside the rename window",
      );
    }

    const hasUnresolvedConflict = useExternalRootStore
      .getState()
      .conflicts.some((conflict) =>
        keysAffectTargets(
          new Set([externalPathKey(conflict.rootId, conflict.relPath)]),
          targets,
        ),
      );
    if (hasUnresolvedConflict) {
      throw new Error("An external source has an unresolved conflict");
    }
    if (expectations) {
      await verifyExternalMountSourcesOnDisk(targets, expectations);
    }
    return;
  }

  throw new Error("External source mutations did not reach quiescence");
}

/** @internal test helper */
export function _resetRecentDeletes(): void {
  recentDeletes.length = 0;
}

export async function loadRootsFromSettings(
  projectId = getCurrentProjectId(),
): Promise<ExternalRoot[]> {
  const raw = await getProjectSetting(projectId, EXTERNAL_ROOTS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ExternalRoot[];
  } catch {
    return [];
  }
}

export async function saveRootsToSettings(
  roots: ExternalRoot[],
  projectId = getCurrentProjectId(),
): Promise<void> {
  await setProjectSetting(projectId, EXTERNAL_ROOTS_KEY, JSON.stringify(roots));
}

// Boot fires this 2x (App.tsx StrictMode double-effect) plus 1x from
// reloadProjectData during loadProject. All three race past the
// `previous = []` snapshot, skip the unregister loop, and collide at
// registerMount with "overlaps with existing root: <self>". Dedup
// concurrent calls for the same project; chain across projects so a
// rapid switch still re-inits after the prior project's init drains.
interface ExternalMountInitializationScope {
  projectId: string;
  workspaceOpenRevision: number | undefined;
  workspacePath: string | null;
  authorityToken: number;
  previousRoots: ExternalRoot[];
}

class ExternalMountAuthoritySupersededError extends Error {
  constructor() {
    super("External mount authority was superseded");
    this.name = "ExternalMountAuthoritySupersededError";
  }
}

type MountAuthorityGuard = () => boolean;

let mountAuthorityToken = 0;
const rootAuthorityTokens = new Map<string, number>();

interface CapturedMountAuthority {
  projectId: string;
  token: number;
  workspaceOpenRevision: number | undefined;
  isCurrent: MountAuthorityGuard;
}

function assertMountAuthorityCurrent(isCurrent: MountAuthorityGuard): void {
  if (!isCurrent()) throw new ExternalMountAuthoritySupersededError();
}

function captureMountAuthority(rootId?: string): CapturedMountAuthority | null {
  const projectId = getCurrentProjectId();
  const token = mountAuthorityToken;
  const workspace = getCurrentWorkspaceIdentity();
  if (
    rootId !== undefined &&
    token !== 0 &&
    rootAuthorityTokens.get(rootId) !== token
  ) {
    return null;
  }
  const isCurrent = () => {
    if (token !== mountAuthorityToken || getCurrentProjectId() !== projectId) {
      return false;
    }
    if (
      rootId !== undefined &&
      token !== 0 &&
      rootAuthorityTokens.get(rootId) !== token
    ) {
      return false;
    }
    const currentWorkspace = getCurrentWorkspaceIdentity();
    return workspace === null
      ? currentWorkspace === null
      : currentWorkspace?.path === workspace.path &&
          currentWorkspace.openRevision === workspace.openRevision;
  };
  return {
    projectId,
    token,
    workspaceOpenRevision: workspace?.openRevision,
    isCurrent,
  };
}

/** @internal test helper */
export function _resetMountAuthorityForTests(): void {
  mountAuthorityToken = 0;
  rootAuthorityTokens.clear();
  inFlightInit = null;
  _resetPendingArchives();
  recentDeletes.length = 0;
  activeFileEvents.clear();
  fileEventRootChains.clear();
  failedFileEvents.clear();
  fileEventFailureRevision = 0;
}

let inFlightInit: {
  scope: ExternalMountInitializationScope;
  promise: Promise<void>;
} | null = null;

export interface InitializeExternalMountsOptions {
  projectId?: string;
  workspaceOpenRevision?: number;
}

export async function initializeExternalMounts(
  options: InitializeExternalMountsOptions = {},
): Promise<void> {
  const projectId = options.projectId ?? getCurrentProjectId();
  const currentWorkspace = getCurrentWorkspaceIdentity();
  const workspaceOpenRevision =
    options.workspaceOpenRevision ?? currentWorkspace?.openRevision;
  const desiredScope = {
    projectId,
    workspaceOpenRevision,
    workspacePath:
      currentWorkspace !== null &&
      currentWorkspace.openRevision === workspaceOpenRevision
        ? currentWorkspace.path
        : null,
  };
  if (
    inFlightInit &&
    inFlightInit.scope.projectId === desiredScope.projectId &&
    inFlightInit.scope.workspaceOpenRevision ===
      desiredScope.workspaceOpenRevision &&
    inFlightInit.scope.workspacePath === desiredScope.workspacePath
  ) {
    return inFlightInit.promise;
  }
  const scope: ExternalMountInitializationScope = {
    ...desiredScope,
    authorityToken: ++mountAuthorityToken,
    previousRoots: useExternalRootStore.getState().roots,
  };
  // A newly accepted scope synchronously revokes every watcher callback and
  // delayed archive owned by the prior Workspace before either init resumes.
  _resetPendingArchives();
  recentDeletes.length = 0;
  rootAuthorityTokens.clear();
  useExternalRootStore.setState({
    roots: [],
    missingRoots: [],
    isInitialized: false,
    conflicts: [],
    mutedWrites: [],
  });
  const previousInit = inFlightInit?.promise;
  const entry: {
    scope: ExternalMountInitializationScope;
    promise: Promise<void>;
  } = {
    scope,
    promise: Promise.resolve(),
  };
  entry.promise = (async () => {
    if (previousInit) await previousInit.catch(() => {});
    try {
      await doInitializeExternalMounts(scope);
    } finally {
      if (inFlightInit === entry) inFlightInit = null;
    }
  })();
  inFlightInit = entry;
  return entry.promise;
}

async function doInitializeExternalMounts(
  scope: ExternalMountInitializationScope,
): Promise<void> {
  const { projectId } = scope;
  const isCurrent = () => isInitializationMutationScopeCurrent(scope);
  const previous = scope.previousRoots;
  for (const root of previous) {
    assertMountAuthorityCurrent(isCurrent);
    try {
      await mountApi.unregisterMount(root.id);
      assertMountAuthorityCurrent(isCurrent);
    } catch (err) {
      if (err instanceof ExternalMountAuthoritySupersededError) throw err;
      // ignore stale watchers
    }
  }

  const missing: ExternalRoot[] = [];
  let treeMayHaveChanged = false;
  try {
    assertMountAuthorityCurrent(isCurrent);
    const roots = await loadRootsFromSettings(projectId);
    assertMountAuthorityCurrent(isCurrent);
    useExternalRootStore.getState().setRoots(roots);
    try {
      treeMayHaveChanged =
        (await purgeExpiredArchives(projectId, isCurrent)) > 0;
    } catch (error) {
      // A targeted delete can fail after an earlier row was removed. Force a
      // Tree refresh in the failure finalizer so partial cleanup cannot leave
      // the published projection stale.
      treeMayHaveChanged = true;
      throw error;
    }
    assertMountAuthorityCurrent(isCurrent);

    for (const root of roots) {
      // Reconciliation may create, update, restore, or archive Tree rows.
      // Conservatively refresh once after all roots instead of trying to infer
      // whether every individual disk comparison was a no-op.
      treeMayHaveChanged = true;
      assertMountAuthorityCurrent(isCurrent);
      let scan: ScanResult;
      try {
        scan = await mountApi.registerMount(root.id, root.path, root.label);
        if (!isCurrent()) {
          try {
            await mountApi.unregisterMount(root.id);
          } catch {
            // Best effort: the target scope will establish its own watchers.
          }
          throw new ExternalMountAuthoritySupersededError();
        }
        rootAuthorityTokens.set(root.id, scope.authorityToken);
      } catch (err) {
        if (err instanceof ExternalMountAuthoritySupersededError) throw err;
        debugLog.error(
          "ExternalMount",
          `register failed: ${root.path}`,
          errorDetail(err),
        );
        missing.push(root);
        continue;
      }
      try {
        await reconcileRoot(root, scan, projectId, isCurrent);
      } catch (err) {
        if (err instanceof ExternalMountAuthoritySupersededError) throw err;
        debugLog.error(
          "ExternalMount",
          `reconcile failed: ${root.label}`,
          errorDetail(err),
        );
        toast.error(
          i18next.t("externalMount.toast.reconcileFailed", {
            label: root.label,
          }),
        );
      }
    }
  } catch (err) {
    // loadRootsFromSettings / purgeExpiredArchives が落ちても unscoped boot
    // の UI 初期化を永久に止めないよう、下の finally で最終 tree reload と
    // mountInitialized の判定まで進める。tab restore は tree hydration と
    // project/workspace authority を別途証明できた場合だけ実行する。
    if (!(err instanceof ExternalMountAuthoritySupersededError)) {
      debugLog.error("ExternalMount", "initialize failed", errorDetail(err));
    }
  } finally {
    await finalizeExternalMountInitialization(
      scope,
      missing,
      treeMayHaveChanged,
    );
  }
}

async function finalizeExternalMountInitialization(
  scope: ExternalMountInitializationScope,
  missing: ExternalRoot[],
  treeMayHaveChanged: boolean,
): Promise<void> {
  if (!isInitializationMutationScopeCurrent(scope)) return;
  const { projectId, workspaceOpenRevision } = scope;
  useExternalRootStore.getState().setMissingRoots(missing);
  // The final tree hydration and tab restore form one project/workspace
  // authority boundary. React mount timing must not decide which node IDs
  // are valid for persisted tabs.
  const hydratedTree = useTreeStore.getState();
  let treeHydrated =
    !treeMayHaveChanged &&
    hydratedTree.projectId === projectId &&
    hydratedTree.hydratedProjectId === projectId &&
    hydratedTree.hydratedWorkspaceOpenRevision ===
      (workspaceOpenRevision ?? null);
  if (!treeHydrated) {
    try {
      await useTreeStore
        .getState()
        .reloadTreeOrThrow(projectId, workspaceOpenRevision);
      treeHydrated = true;
    } catch (err) {
      debugLog.error("ExternalMount", "loadTree failed", errorDetail(err));
    }
  }
  const scopeCurrent = treeHydrated && isInitializationScopeCurrent(scope);
  // Legacy/unscoped boot has no revision proof, but must still release the
  // mount UI even on failure. Explicit lifecycle work may publish this
  // global flag only while its captured Project/Workspace is still current.
  if (workspaceOpenRevision === undefined || scopeCurrent) {
    useExternalRootStore.getState().setInitialized(true);
  }
  if (!scopeCurrent) return;

  const treeState = useTreeStore.getState();
  const validNodeIds = new Set<string>();
  for (const node of treeState.nodes) {
    if (node.nodeType === "scene" || node.nodeType === "note") {
      validNodeIds.add(node.id);
    }
  }
  const applied = await useTabStore
    .getState()
    .loadTabState(projectId, validNodeIds, (snapshot) => {
      if (!isInitializationScopeCurrent(scope)) return false;
      const restoredSceneId = getPersistedActiveSceneId(snapshot);
      if (restoredSceneId && validNodeIds.has(restoredSceneId)) {
        useTreeStore.getState().setActiveScene(restoredSceneId);
      }
      return isInitializationScopeCurrent(scope);
    });
  if (applied && isInitializationScopeCurrent(scope)) {
    useTabStore.getState().initAutoSave(projectId);
  }
}

function isInitializationMutationScopeCurrent(
  scope: ExternalMountInitializationScope,
): boolean {
  if (
    scope.authorityToken !== mountAuthorityToken ||
    getCurrentProjectId() !== scope.projectId
  ) {
    return false;
  }
  const currentWorkspace = getCurrentWorkspaceIdentity();
  if (scope.workspaceOpenRevision === undefined) {
    return currentWorkspace === null;
  }
  if (scope.workspacePath !== null) {
    return (
      currentWorkspace?.path === scope.workspacePath &&
      currentWorkspace.openRevision === scope.workspaceOpenRevision
    );
  }
  return (
    currentWorkspace === null ||
    currentWorkspace.openRevision === scope.workspaceOpenRevision
  );
}

function isInitializationScopeCurrent(
  scope: ExternalMountInitializationScope,
): boolean {
  if (
    !isInitializationMutationScopeCurrent(scope) ||
    scope.workspaceOpenRevision === undefined
  ) {
    return false;
  }
  const treeState = useTreeStore.getState();
  if (
    treeState.projectId !== scope.projectId ||
    treeState.hydratedProjectId !== scope.projectId ||
    treeState.hydratedWorkspaceOpenRevision !== scope.workspaceOpenRevision
  ) {
    return false;
  }
  const currentWorkspace = getCurrentWorkspaceIdentity();
  if (scope.workspacePath !== null) {
    return (
      currentWorkspace?.path === scope.workspacePath &&
      currentWorkspace.openRevision === scope.workspaceOpenRevision
    );
  }
  return (
    currentWorkspace === null ||
    currentWorkspace.openRevision === scope.workspaceOpenRevision
  );
}

export async function addExternalMount(
  path: string,
  label?: string,
): Promise<void> {
  return runTreeTopologyMutation(() =>
    addExternalMountWithAuthority(path, label),
  );
}

async function addExternalMountWithAuthority(
  path: string,
  label?: string,
): Promise<void> {
  const authority = captureMountAuthority();
  if (!authority) return;
  const { projectId, isCurrent } = authority;
  const id = crypto.randomUUID();
  const resolvedLabel = label ?? basename(path);
  const root: ExternalRoot = { id, path, label: resolvedLabel };
  const scan = await mountApi.registerMount(id, path, resolvedLabel);
  if (!isCurrent()) {
    try {
      await mountApi.unregisterMount(id);
    } catch {
      // Best-effort cleanup of the watcher created for a superseded scope.
    }
    return;
  }
  assertMountAuthorityCurrent(isCurrent);
  rootAuthorityTokens.set(id, authority.token);
  const roots = [...(await loadRootsFromSettings(projectId)), root];
  assertMountAuthorityCurrent(isCurrent);
  await saveRootsToSettings(roots, projectId);
  assertMountAuthorityCurrent(isCurrent);
  useExternalRootStore.getState().addRoot(root);
  await reconcileRoot(root, scan, projectId, isCurrent);
  assertMountAuthorityCurrent(isCurrent);
  await useTreeStore
    .getState()
    .loadTree(projectId, authority.workspaceOpenRevision);
  assertMountAuthorityCurrent(isCurrent);
  toast.success(
    i18next.t("externalMount.toast.mounted", { label: resolvedLabel }),
  );
}

export async function removeExternalMount(rootId: string): Promise<void> {
  return runTreeTopologyMutation(() =>
    removeExternalMountWithAuthority(rootId),
  );
}

async function removeExternalMountWithAuthority(rootId: string): Promise<void> {
  const authority = captureMountAuthority(rootId);
  if (!authority) return;
  const { projectId, isCurrent } = authority;
  await mountApi.unregisterMount(rootId);
  assertMountAuthorityCurrent(isCurrent);
  rootAuthorityTokens.delete(rootId);
  const roots = (await loadRootsFromSettings(projectId)).filter(
    (r) => r.id !== rootId,
  );
  assertMountAuthorityCurrent(isCurrent);
  await saveRootsToSettings(roots, projectId);
  assertMountAuthorityCurrent(isCurrent);
  useExternalRootStore.getState().removeRoot(rootId);

  const prefix = rootPrefix(rootId);
  const nodes = await listAllNodes(projectId);
  assertMountAuthorityCurrent(isCurrent);
  const { deleteNode } = await import("@/features/tree/api");
  for (const node of nodes) {
    assertMountAuthorityCurrent(isCurrent);
    if (node.sourceUri?.startsWith(prefix)) {
      await deleteNode(node.id);
      assertMountAuthorityCurrent(isCurrent);
    }
  }
  await useTreeStore
    .getState()
    .loadTree(projectId, authority.workspaceOpenRevision);
  clearFileEventFailuresForRoot(rootId);
  toast.success(i18next.t("externalMount.toast.removed"));
}

function rootPrefix(rootId: string): string {
  return `external-root://${rootId}/`;
}

function externalFileParentId(
  relPath: string,
  mountFolderId: string,
  folderIds: ReadonlyMap<string, string>,
): string {
  const parentRel = dirname(relPath);
  return parentRel == null
    ? mountFolderId
    : (folderIds.get(parentRel) ?? mountFolderId);
}

async function reconcileRoot(
  root: ExternalRoot,
  scan: ScanResult,
  projectId = getCurrentProjectId(),
  isCurrent: MountAuthorityGuard = () => true,
): Promise<void> {
  const failureRevisionAtStart = fileEventFailureRevision;
  assertMountAuthorityCurrent(isCurrent);
  const allNodes = await listAllNodes(projectId);
  assertMountAuthorityCurrent(isCurrent);
  const prefix = rootPrefix(root.id);

  const mountFolderUri = buildMountFolderUri(root.id);
  let mountFolder = allNodes.find((n) => n.sourceUri === mountFolderUri);
  if (!mountFolder) {
    assertMountAuthorityCurrent(isCurrent);
    mountFolder = await createNode({
      id: crypto.randomUUID(),
      projectId,
      nodeType: "folder",
      title: root.label,
      sortOrder: nextSortOrder(allNodes, null),
      parentId: null,
      sourceUri: mountFolderUri,
    });
    assertMountAuthorityCurrent(isCurrent);
  }

  const dbByUri = await buildDbByUriMap(
    allNodes,
    prefix,
    mountFolderUri,
    isCurrent,
  );
  assertMountAuthorityCurrent(isCurrent);

  const diskByPath = new Map(scan.files.map((f) => [f.relPath, f]));
  const folderIds = await ensureFolderTree(
    root,
    scan,
    mountFolder.id,
    allNodes,
    projectId,
    isCurrent,
  );
  assertMountAuthorityCurrent(isCurrent);
  const diskFolderPaths = new Set(scan.dirs.map((dir) => dir.relPath));
  for (const folder of allNodes) {
    if (
      folder.nodeType !== "folder" ||
      folder.archivedAt ||
      !folder.sourceUri?.startsWith(prefix) ||
      folder.sourceUri === mountFolderUri
    ) {
      continue;
    }
    const parsed = parseSourceUri(folder.sourceUri);
    if (!parsed || diskFolderPaths.has(parsed.relPath)) continue;
    assertMountAuthorityCurrent(isCurrent);
    await softArchiveNode(folder.id);
    assertMountAuthorityCurrent(isCurrent);
  }

  // Boot-time rename detection via normalized-markdown content hash.
  // scan.files[].contentHash は disk の生 markdown を直接 SHA-256 したもので、
  // pmJsonToMarkdown を通った後の正規化形と一致しないため使えない (round-trip
  // drift: trailing newline 付加、段落間空行の縮退など)。disk 側も hashForDiskContent
  // で同じ pmJsonToMarkdown 経路を通してから比較する。
  const dbOnly = [...dbByUri.entries()].filter(
    ([uri, node]) =>
      !node.archivedAt && !diskByPath.has(parseSourceUri(uri)?.relPath ?? ""),
  );
  const diskOnly = scan.files.filter(
    (f) => !dbByUri.has(buildSourceUri(root.id, f.relPath)),
  );

  const diskHashByPath = new Map<string, string>();
  for (const f of diskOnly) {
    assertMountAuthorityCurrent(isCurrent);
    diskHashByPath.set(f.relPath, await hashForDiskContent(f.content));
    assertMountAuthorityCurrent(isCurrent);
  }

  // listAllNodes は content を返さない軽量 projection (H4) なので、rename 検知
  // ハッシュの対象 (DB にあって disk に無い少数ノード) だけ本文をバッチロードして
  // hashForNode に注入する。
  const dbOnlyContents = await loadSceneContents(dbOnly.map(([, n]) => n.id));
  assertMountAuthorityCurrent(isCurrent);

  for (const [uri, node] of dbOnly) {
    assertMountAuthorityCurrent(isCurrent);
    const parsed = parseSourceUri(uri);
    if (!parsed) continue;
    const content = dbOnlyContents.get(node.id);
    const nodeHash =
      content !== undefined ? await hashForNode({ content }) : null;
    assertMountAuthorityCurrent(isCurrent);
    const match =
      nodeHash != null
        ? diskOnly.find((f) => diskHashByPath.get(f.relPath) === nodeHash)
        : undefined;
    if (match) {
      const newUri = buildSourceUri(root.id, match.relPath);
      const parentId = externalFileParentId(
        match.relPath,
        mountFolder.id,
        folderIds,
      );
      assertMountAuthorityCurrent(isCurrent);
      await updateNode(node.id, {
        sourceUri: newUri,
        title: titleFromFilename(basename(match.relPath)),
        sourceMtime: match.mtime,
        parentId,
        sortOrder: sortOrderForFilename(match.relPath),
      });
      assertMountAuthorityCurrent(isCurrent);
      diskOnly.splice(diskOnly.indexOf(match), 1);
      dbByUri.delete(uri);
      dbByUri.set(newUri, { ...node, sourceUri: newUri });
    } else if (!node.archivedAt) {
      assertMountAuthorityCurrent(isCurrent);
      await softArchiveNode(node.id);
      assertMountAuthorityCurrent(isCurrent);
    }
  }

  for (const file of scan.files) {
    assertMountAuthorityCurrent(isCurrent);
    const uri = buildSourceUri(root.id, file.relPath);
    const existing = dbByUri.get(uri);
    const parentId = externalFileParentId(
      file.relPath,
      mountFolder.id,
      folderIds,
    );
    if (existing?.archivedAt) {
      assertMountAuthorityCurrent(isCurrent);
      await updateNode(existing.id, {
        archivedAt: null,
        sourceMtime: file.mtime,
      });
      assertMountAuthorityCurrent(isCurrent);
    }
    if (existing) {
      if (existing.parentId !== parentId) {
        assertMountAuthorityCurrent(isCurrent);
        await updateNode(existing.id, {
          parentId,
          sortOrder: sortOrderForFilename(file.relPath),
        });
        assertMountAuthorityCurrent(isCurrent);
      }
      await syncFileCache(existing.id, file, isCurrent);
    } else {
      await upsertSceneFromFile(
        root,
        file,
        mountFolder.id,
        folderIds,
        projectId,
        isCurrent,
      );
    }
    assertMountAuthorityCurrent(isCurrent);
  }
  clearFileEventFailuresForRoot(root.id, failureRevisionAtStart);
}

async function hashForNode(node: { content: string }): Promise<string | null> {
  try {
    const markdown = pmJsonToMarkdown(node.content);
    return await contentHash(markdown);
  } catch {
    return null;
  }
}

/**
 * Compute a rename-detection hash from raw disk Markdown that survives the
 * `markdown → pmjson → markdown` round-trip drift (段落間空行の縮退、末尾改行の
 * 付加、リストマーカーの差異など)。`hashForNode` と同じ正規化経路を通すので、
 * 同一内容のファイルがどちらの起点でも同じハッシュになる。Rust 側 scan が返す
 * 生 markdown の SHA-256 (= `scan.files[].contentHash`) はリネーム判定には使えない。
 */
export async function hashForDiskContent(content: string): Promise<string> {
  const pmJson = JSON.stringify(markdownToPmJson(content));
  const normalized = pmJsonToMarkdown(pmJson);
  return contentHash(normalized);
}

/** @internal Exported for unit tests. */
export async function hashForNodeContent(
  content: string,
): Promise<string | null> {
  return hashForNode({ content });
}

async function ensureFolderTree(
  root: ExternalRoot,
  scan: ScanResult,
  mountFolderId: string,
  allNodes: Awaited<ReturnType<typeof listAllNodes>>,
  projectId: string,
  isCurrent: MountAuthorityGuard,
): Promise<Map<string, string>> {
  const folderIds = new Map<string, string>();
  const sortedDirs = [...scan.dirs].sort((a, b) =>
    a.relPath.localeCompare(b.relPath),
  );

  for (const dir of sortedDirs) {
    assertMountAuthorityCurrent(isCurrent);
    const uri = buildSourceUri(root.id, dir.relPath);
    const parentRel = dirname(dir.relPath);
    const parentId =
      parentRel == null
        ? mountFolderId
        : (folderIds.get(parentRel) ?? mountFolderId);
    let node = allNodes.find((n) => n.sourceUri === uri);
    if (!node) {
      node = await createNode({
        id: crypto.randomUUID(),
        projectId,
        nodeType: "folder",
        title: dir.name,
        sortOrder: nextSortOrder(allNodes, parentId),
        parentId,
        sourceUri: uri,
      });
      assertMountAuthorityCurrent(isCurrent);
      allNodes.push(node);
    } else if (node.archivedAt || node.parentId !== parentId) {
      assertMountAuthorityCurrent(isCurrent);
      await updateNode(node.id, { archivedAt: null, parentId });
      assertMountAuthorityCurrent(isCurrent);
      node = { ...node, archivedAt: null, parentId };
    }
    folderIds.set(dir.relPath, node.id);
  }
  return folderIds;
}

/** @internal Exported for unit tests. */
export async function buildDbByUriMap(
  allNodes: Awaited<ReturnType<typeof listAllNodes>>,
  prefix: string,
  mountFolderUri: string,
  isCurrent: MountAuthorityGuard = () => true,
): Promise<Map<string, Awaited<ReturnType<typeof listAllNodes>>[number]>> {
  const candidates = allNodes.filter(
    (n) =>
      n.nodeType === "scene" &&
      n.sourceUri?.startsWith(prefix) &&
      n.sourceUri !== mountFolderUri,
  );
  const grouped = new Map<string, typeof candidates>();
  for (const node of candidates) {
    const uri = node.sourceUri!;
    const group = grouped.get(uri) ?? [];
    group.push(node);
    grouped.set(uri, group);
  }

  const map = new Map<string, (typeof candidates)[number]>();
  for (const [uri, nodes] of grouped) {
    const active = nodes.filter((n) => !n.archivedAt);
    if (active.length > 1) {
      active.sort((a, b) => compareInstantValues(a.createdAt, b.createdAt));
      for (const dup of active.slice(1)) {
        assertMountAuthorityCurrent(isCurrent);
        await softArchiveNode(dup.id);
        assertMountAuthorityCurrent(isCurrent);
      }
    }
    const preferred =
      active[0] ??
      nodes
        .slice()
        .sort((a, b) => compareInstantValues(a.createdAt, b.createdAt))[0];
    if (preferred) map.set(uri, preferred);
  }
  return map;
}

async function upsertSceneFromFile(
  root: ExternalRoot,
  file: ScannedFile,
  mountFolderId: string,
  folderIds: Map<string, string>,
  projectId: string,
  isCurrent: MountAuthorityGuard,
): Promise<void> {
  assertMountAuthorityCurrent(isCurrent);
  const uri = buildSourceUri(root.id, file.relPath);
  const existing = (await listAllNodes(projectId)).find(
    (n) => n.sourceUri === uri,
  );
  assertMountAuthorityCurrent(isCurrent);
  if (existing) {
    if (existing.archivedAt) {
      assertMountAuthorityCurrent(isCurrent);
      await updateNode(existing.id, {
        archivedAt: null,
        sourceMtime: file.mtime,
      });
      assertMountAuthorityCurrent(isCurrent);
    }
    await syncFileCache(existing.id, file, isCurrent);
    return;
  }

  const parentId = externalFileParentId(file.relPath, mountFolderId, folderIds);
  const pmJson = JSON.stringify(markdownToPmJson(file.content));
  const charCount = countSceneBodyCharsFromJson(pmJson);
  assertMountAuthorityCurrent(isCurrent);
  const node = await createNode({
    id: crypto.randomUUID(),
    projectId,
    nodeType: "scene",
    title: titleFromFilename(basename(file.relPath)),
    sortOrder: sortOrderForFilename(file.relPath),
    parentId,
    sourceUri: uri,
    sourceMtime: file.mtime,
    content: pmJson,
  });
  assertMountAuthorityCurrent(isCurrent);
  await saveSceneContent(node.id, { content: pmJson, charCount });
  assertMountAuthorityCurrent(isCurrent);
  scheduleSceneIndex(node.id);
}

async function syncFileCache(
  nodeId: string,
  file: ScannedFile,
  isCurrent: MountAuthorityGuard = () => true,
): Promise<void> {
  const pmJson = JSON.stringify(markdownToPmJson(file.content));
  const charCount = countSceneBodyCharsFromJson(pmJson);
  assertMountAuthorityCurrent(isCurrent);
  await saveSceneContent(nodeId, { content: pmJson, charCount });
  assertMountAuthorityCurrent(isCurrent);
  await updateNode(nodeId, {
    sourceMtime: file.mtime,
    title: titleFromFilename(basename(file.relPath)),
  });
  assertMountAuthorityCurrent(isCurrent);
  scheduleSceneIndex(nodeId);
}

function sortOrderForFilename(relPath: string): string {
  return basename(relPath).toLowerCase();
}

function nextSortOrder(
  nodes: { parentId: string | null; sortOrder: string }[],
  parentId: string | null,
): string {
  const siblings = nodes.filter((n) => n.parentId === parentId);
  const keys = generateNKeysBetween(
    null,
    null,
    Math.max(siblings.length + 1, 1),
  );
  return keys[keys.length - 1] ?? "a0";
}

async function softArchiveNode(nodeId: string): Promise<void> {
  await updateNode(nodeId, { archivedAt: new Date().toISOString() });
}

export async function purgeExpiredArchives(
  projectId = getCurrentProjectId(),
  isCurrent: MountAuthorityGuard = () => true,
): Promise<number> {
  const cutoff = new Date(Date.now() - ARCHIVE_RETENTION_MS).toISOString();
  assertMountAuthorityCurrent(isCurrent);
  const expiredIds = await listExpiredArchivedNodeIds(projectId, cutoff);
  let deletedCount = 0;
  for (const id of expiredIds) {
    assertMountAuthorityCurrent(isCurrent);
    await deleteNode(id);
    deletedCount += 1;
    assertMountAuthorityCurrent(isCurrent);
  }
  return deletedCount;
}

export function handleFileEvent(event: FileEvent): Promise<void> {
  const capturedEvent: FileEvent = {
    rootId: event.rootId,
    relPath: event.relPath,
    kind: event.kind,
    ...(typeof event.oldRelPath === "string"
      ? { oldRelPath: event.oldRelPath }
      : {}),
  };
  // Bind the watcher fact to the authority that observed it. A Project or
  // Workspace switch may complete while the event waits behind its lease;
  // that stale fact must not be replayed into the newly opened scope.
  const authority = captureMountAuthority(capturedEvent.rootId);
  if (!authority) return Promise.resolve();
  if (capturedEvent.kind === "changed" || capturedEvent.kind === "added") {
    cancelPendingArchive(capturedEvent.rootId, capturedEvent.relPath);
  } else if (capturedEvent.kind === "renamed") {
    cancelPendingArchive(capturedEvent.rootId, capturedEvent.relPath);
    if (capturedEvent.oldRelPath) {
      cancelPendingArchive(capturedEvent.rootId, capturedEvent.oldRelPath);
    }
  }
  if (
    useExternalRootStore
      .getState()
      .isMuted(capturedEvent.rootId, capturedEvent.relPath)
  ) {
    const mutedBarrier = beginRootFileEvent(
      capturedEvent.rootId,
      authority.token,
      async () => {
        if (!authority.isCurrent()) return;
        if (
          capturedEvent.kind === "changed" ||
          capturedEvent.kind === "added"
        ) {
          cancelPendingArchive(capturedEvent.rootId, capturedEvent.relPath);
        } else if (capturedEvent.kind === "renamed") {
          cancelPendingArchive(capturedEvent.rootId, capturedEvent.relPath);
          if (capturedEvent.oldRelPath) {
            cancelPendingArchive(
              capturedEvent.rootId,
              capturedEvent.oldRelPath,
            );
          }
        }
      },
    );
    extendRootFileEventChain(
      capturedEvent.rootId,
      authority.token,
      mutedBarrier,
    );
    return mutedBarrier;
  }
  const observedDuringNarrativeSnapshot =
    isQuiescenceLeaseActive("narrative-snapshot");
  const failureKeys = new Set(eventPathKeys(capturedEvent));
  const activeKeys = new Set(failureKeys);
  if (capturedEvent.kind === "added" || capturedEvent.kind === "renamed") {
    // Either event can fall back to full-root reconciliation after awaiting a
    // scan. Track that conservative scope from observation so a snapshot
    // cannot pass settlement during the pre-reconcile await window.
    activeKeys.add(externalRootWideKey(capturedEvent.rootId));
  }
  const markRootWide = (): void => {
    // Sticky failure scope is narrower: only a task that actually began a
    // root reconciliation can poison every source path in that root.
    failureKeys.add(externalRootWideKey(capturedEvent.rootId));
  };
  const markFailurePath = (relPath: string): void => {
    failureKeys.add(externalPathKey(capturedEvent.rootId, relPath));
  };
  const tracked = createTrackedFileEvent(
    activeKeys,
    authority.isCurrent,
    observedDuringNarrativeSnapshot,
  );
  let failureRevisionAtStart = fileEventFailureRevision;
  const run = async (): Promise<FileEventReconciliation> => {
    // The event may have waited behind an earlier fact for the same root. Its
    // successful retry must be able to clear a failure emitted by that fact.
    failureRevisionAtStart = fileEventFailureRevision;
    while (!canScheduleQuiescenceMutation()) {
      if (tracked.permitUnderQuiescence) {
        if (!authority.isCurrent()) return { kind: "none" };
        return await schedulePreexistingParticipantMutation(() => {
          tracked.admitted = true;
          return handleFileEventImpl(
            capturedEvent,
            authority,
            markRootWide,
            markFailurePath,
            () => tracked.permitUnderQuiescence,
          );
        });
      }
      const admission = await Promise.race([
        waitForQuiescenceMutationAdmission().then((allowed) => ({
          kind: "admission" as const,
          allowed,
        })),
        tracked.permitSignal.then(() => ({ kind: "permit" as const })),
      ]);
      if (admission.kind === "permit") continue;
      if (!admission.allowed) {
        return { kind: "none" };
      }
    }
    if (!authority.isCurrent()) return { kind: "none" };
    tracked.grantQuiescencePermit();
    tracked.admitted = true;
    return await handleFileEventImpl(
      capturedEvent,
      authority,
      markRootWide,
      markFailurePath,
      () => tracked.permitUnderQuiescence,
    );
  };
  const operation = beginRootFileEvent(
    capturedEvent.rootId,
    authority.token,
    run,
  );
  const task = operation
    .then((reconciled) => {
      if (reconciled.kind === "paths") {
        clearFileEventFailures(reconciled.keys, failureRevisionAtStart);
      } else if (reconciled.kind === "root") {
        clearFileEventFailuresForRoot(
          reconciled.rootId,
          failureRevisionAtStart,
        );
      }
    })
    .catch((error: unknown) => {
      recordFileEventFailure(failureKeys, error, authority.isCurrent);
      throw error;
    });
  extendRootFileEventChain(capturedEvent.rootId, authority.token, task);
  activeFileEvents.set(task, tracked);
  return task.finally(() => {
    activeFileEvents.delete(task);
  });
}

type FileEventReconciliation =
  | { readonly kind: "none" }
  | { readonly kind: "paths"; readonly keys: ReadonlySet<string> }
  | { readonly kind: "root"; readonly rootId: string };

async function handleFileEventImpl(
  event: FileEvent,
  authority: CapturedMountAuthority,
  markRootWide: () => void,
  markFailurePath: (relPath: string) => void,
  isQuiescenceMutationPermitted: () => boolean,
): Promise<FileEventReconciliation> {
  if (useExternalRootStore.getState().isMuted(event.rootId, event.relPath)) {
    return { kind: "none" };
  }

  const root = useExternalRootStore
    .getState()
    .roots.find((r) => r.id === event.rootId);
  if (!root) return { kind: "none" };

  try {
    switch (event.kind) {
      case "changed":
        await handleFileChanged(
          root,
          event.relPath,
          authority.projectId,
          authority.isCurrent,
          authority.workspaceOpenRevision,
          isQuiescenceMutationPermitted,
        );
        return { kind: "paths", keys: eventPathKeys(event) };
      case "added":
        return await handleFileAdded(
          root,
          event.relPath,
          authority.projectId,
          authority.isCurrent,
          authority.workspaceOpenRevision,
          markRootWide,
          markFailurePath,
        );
      case "removed":
        await handleFileRemoved(
          root,
          event.relPath,
          authority.projectId,
          authority.isCurrent,
          authority.workspaceOpenRevision,
          authority.token,
        );
        return { kind: "none" };
      case "renamed":
        if (event.oldRelPath) {
          return await handleFileRenamed(
            root,
            event.oldRelPath,
            event.relPath,
            authority.projectId,
            authority.isCurrent,
            authority.workspaceOpenRevision,
            markRootWide,
            markFailurePath,
          );
        }
        return { kind: "none" };
    }
  } catch (err) {
    if (!(err instanceof ExternalMountAuthoritySupersededError)) throw err;
    return { kind: "none" };
  }
}

async function handleFileChanged(
  root: ExternalRoot,
  relPath: string,
  projectId: string,
  isCurrent: MountAuthorityGuard,
  workspaceOpenRevision?: number,
  isQuiescenceMutationPermitted: () => boolean = () => false,
): Promise<void> {
  assertMountAuthorityCurrent(isCurrent);
  cancelPendingArchive(root.id, relPath);
  const uri = buildSourceUri(root.id, relPath);
  const node = await findNodeByUri(uri, projectId, isCurrent);
  if (!node) return;

  const content = await mountApi.readExternalFile(root.id, relPath);
  assertMountAuthorityCurrent(isCurrent);
  const fileMtime = await mountApi.getExternalFileMtime(root.id, relPath);
  assertMountAuthorityCurrent(isCurrent);
  const documentKey: DocumentKey = {
    kind: "tree",
    id: node.id,
    storage: "file",
  };
  const conflict = {
    sceneId: node.id,
    rootId: root.id,
    relPath,
    incomingContent: content,
    incomingMtime: fileMtime,
  };
  const hasLocalDraft = () =>
    useEditorSessionStore.getState().isDocumentDirty(documentKey) ||
    hasPendingOrFailedAutoSaveForDocument(documentKey) ||
    hasRetainedRecoveryDraftForDocument(documentKey) ||
    hasPendingWriteBack(node.id);

  // Fast-path obvious conflicts before acquiring the exact-document lease.
  // A destructive global lifecycle is already draining this authority, so a
  // watcher callback must not start a new import behind it.
  if (
    hasLocalDraft() ||
    !canScheduleQuiescenceMutation({
      preexistingDraft: isQuiescenceMutationPermitted(),
    })
  ) {
    assertMountAuthorityCurrent(isCurrent);
    useExternalRootStore.getState().enqueueConflict(conflict);
    return;
  }

  const applied = await runExclusiveDocumentMutation(
    documentKey,
    async ({ markAuthoritativeMutation }) => {
      assertMountAuthorityCurrent(isCurrent);
      // A local save may have been issued just before the lease and be waiting
      // in either the document coordinator or lower per-scene DB chain. Wait
      // for both, then re-check. Its file-backed OUT draft is the durable
      // signal that automatic IN must yield to a conflict.
      await awaitPendingSceneContentWrite(node.id);
      assertMountAuthorityCurrent(isCurrent);
      if (hasLocalDraft()) return false;
      await applyExternalContent(
        node.id,
        root.id,
        relPath,
        content,
        fileMtime,
        projectId,
        isCurrent,
        workspaceOpenRevision,
        markAuthoritativeMutation,
      );
      return true;
    },
    { didMutate: Boolean },
  );
  assertMountAuthorityCurrent(isCurrent);
  if (!applied) {
    assertMountAuthorityCurrent(isCurrent);
    useExternalRootStore.getState().enqueueConflict(conflict);
  }
}

async function applyExternalContent(
  nodeId: string,
  _rootId: string,
  relPath: string,
  markdown: string,
  sourceMtime?: string,
  projectId = getCurrentProjectId(),
  isCurrent: MountAuthorityGuard = () => true,
  workspaceOpenRevision?: number,
  onContentReplaced?: () => void,
): Promise<void> {
  const pmJson = JSON.stringify(markdownToPmJson(markdown));
  const charCount = countSceneBodyCharsFromJson(pmJson);
  assertMountAuthorityCurrent(isCurrent);
  const { contentVersion, contentUpdatedAt } = await saveSceneContent(nodeId, {
    content: pmJson,
    charCount,
  });
  // Publish the authoritative DB replacement before any fallible metadata,
  // timelapse, tree, mention, or chat side effect. Mounted editors subscribe
  // to this exact file-backed document nonce and will reload the canonical DB
  // body even when a later side effect rejects.
  onContentReplaced?.();
  publishExternalDocumentReload(
    encodeDocumentKey({
      kind: "tree",
      id: nodeId,
      storage: "file",
    }),
  );
  assertMountAuthorityCurrent(isCurrent);
  await updateNode(nodeId, {
    sourceMtime: sourceMtime ?? new Date().toISOString(),
  });
  assertMountAuthorityCurrent(isCurrent);
  // External file → app (IN) rewrites scene content in the DB and the live
  // editor reload runs with isApplyingExternalUpdate=true, so no doc.step is
  // recorded. Mark the sync and re-anchor the scene baseline at the chain tail
  // so later edits replay on the imported content (no RangeError).
  //
  // Defensive: this path is reached for file-content events (→ scene nodes),
  // but a folder also carries a sourceUri. change_events.sceneId is a valid FK
  // to ANY tree node (no flush-wedge), yet baselining a folder as an editor
  // scene would be a wasted, never-replayed snapshot — so skip positively-known
  // folders. A brand-new scene not yet in the store still proceeds.
  const knownNode = useTreeStore.getState().nodes?.find((n) => n.id === nodeId);
  if (knownNode?.nodeType !== "folder") {
    assertMountAuthorityCurrent(isCurrent);
    recordChangeEvent({
      domain: "mount",
      opType: "file.import",
      entityType: "scene",
      entityId: nodeId,
      sceneId: nodeId,
      projectId,
      payload: { sceneId: nodeId, charCount },
    });
    await rebaselineScenesAtTail(projectId, [nodeId]);
    assertMountAuthorityCurrent(isCurrent);
  }
  assertMountAuthorityCurrent(isCurrent);
  scheduleSceneIndex(nodeId);
  useTreeStore.getState().setCharCount(nodeId, charCount);
  await useTreeStore.getState().loadTree(projectId, workspaceOpenRevision);
  assertMountAuthorityCurrent(isCurrent);

  // 外部編集の取り込みはトーストを出さない無音イベントなので、
  // SR 利用者へ aria-live で通知する (WCAG 4.1.3)。
  assertMountAuthorityCurrent(isCurrent);
  announce(
    i18next.t("externalMount.a11y.fileImported", {
      name: basename(relPath),
      defaultValue: "外部ファイル「{{name}}」の変更を取り込みました",
    }),
  );

  // file-backed Scene でも schema 非依存の Codex 本文検出と チャット context
  // 再構築は実行する。Mention 拡張のような schema 依存処理は file-backed
  // editor 側で外しているのでここでは扱わない (see fileBackedEditorExtensions.ts)。
  assertMountAuthorityCurrent(isCurrent);
  scheduleBodyMentionScan({
    projectId,
    sceneId: nodeId,
    docJsonStr: pmJson,
    sceneVersion: contentVersion,
    sceneUpdatedAt: contentUpdatedAt,
  });
  const chatState = useChatStore.getState();
  if (chatState.activeSceneId === nodeId) {
    assertMountAuthorityCurrent(isCurrent);
    await chatState.refreshContextLayers().catch(() => {});
    assertMountAuthorityCurrent(isCurrent);
  }
}

async function handleFileAdded(
  root: ExternalRoot,
  relPath: string,
  projectId: string,
  isCurrent: MountAuthorityGuard,
  workspaceOpenRevision?: number,
  markRootWide: () => void = () => {},
  markFailurePath: (relPath: string) => void = () => {},
  allowRecentRename = true,
): Promise<FileEventReconciliation> {
  assertMountAuthorityCurrent(isCurrent);
  cancelPendingArchive(root.id, relPath);
  let scan: ScanResult;
  let fileHash: string;
  try {
    scan = await mountApi.scanMount(root.id);
    assertMountAuthorityCurrent(isCurrent);
    const scannedFile = scan.files.find((file) => file.relPath === relPath);
    if (!scannedFile) return { kind: "none" };
    fileHash = await hashForDiskContent(scannedFile.content);
    assertMountAuthorityCurrent(isCurrent);
  } catch (error) {
    markRootWide();
    throw error;
  }
  const file = scan.files.find((f) => f.relPath === relPath);
  if (!file) return { kind: "none" };

  // recentDeletes は handleFileRemoved 側で hashForNode (pmJsonToMarkdown 経路)
  // で計算しているので、disk 側も同じ正規化経路の hashForDiskContent で揃える。
  const recent = recentDeletes.find(
    (d) =>
      d.rootId === root.id &&
      d.contentHash === fileHash &&
      Date.now() - d.at < RENAME_WINDOW_MS,
  );
  const rootWideFailure = failedFileEvents.get(externalRootWideKey(root.id));
  const requiresRootRecovery =
    rootWideFailure !== undefined && rootWideFailure.isAuthorityCurrent();
  if (recent && allowRecentRename && !requiresRootRecovery) {
    markFailurePath(recent.relPath);
    return await handleFileRenamed(
      root,
      recent.relPath,
      relPath,
      projectId,
      isCurrent,
      workspaceOpenRevision,
      markRootWide,
      markFailurePath,
    );
  }

  markRootWide();
  await reconcileRoot(root, scan, projectId, isCurrent);
  assertMountAuthorityCurrent(isCurrent);
  await useTreeStore.getState().loadTree(projectId, workspaceOpenRevision);
  assertMountAuthorityCurrent(isCurrent);
  return { kind: "root", rootId: root.id };
}

async function handleFileRemoved(
  root: ExternalRoot,
  relPath: string,
  projectId: string,
  isCurrent: MountAuthorityGuard,
  workspaceOpenRevision?: number,
  authorityToken = 0,
): Promise<void> {
  assertMountAuthorityCurrent(isCurrent);
  const uri = buildSourceUri(root.id, relPath);
  const node = await findNodeByUri(uri, projectId, isCurrent);
  if (!node) return;

  // handleFileAdded 側で hashForDiskContent と比較するので、削除側も同じ正規化
  // 経路 (hashForNode) で計算する。parse 不能なら rename 候補から除外。
  // findNodeByUri (listAllNodes) の行は content を持たないため単発ロードで注入。
  const hash = await hashForNode({
    content: await loadSceneContent(node.id),
  });
  assertMountAuthorityCurrent(isCurrent);
  if (hash) {
    recentDeletes.push({
      rootId: root.id,
      relPath,
      contentHash: hash,
      at: Date.now(),
    });
  }

  const isDirty = useEditorSessionStore
    .getState()
    .dirtyDocumentIds.has(node.id);
  if (isDirty) {
    toast.warning(i18next.t("externalMount.toast.fileDeletedExternally"));
    return;
  }

  // Atomic saves (delete temp + rename) emit removed before added/changed.
  // Defer archive so tabs and tree nodes stay stable through the window.
  cancelPendingArchive(root.id, relPath);
  const capturedUri = uri;
  const timer = setTimeout(() => {
    cancelPendingArchive(root.id, relPath);
    const keys = new Set([externalPathKey(root.id, relPath)]);
    const tracked = createTrackedFileEvent(
      keys,
      isCurrent,
      isQuiescenceLeaseActive("narrative-snapshot"),
    );
    let failureRevisionAtStart = fileEventFailureRevision;
    const archiveTask = beginRootFileEvent(
      root.id,
      authorityToken,
      async (): Promise<boolean> => {
        while (!canScheduleQuiescenceMutation()) {
          if (tracked.permitUnderQuiescence) {
            if (!isCurrent()) return false;
            return await schedulePreexistingParticipantMutation(() => {
              tracked.admitted = true;
              return executeDeferredArchive();
            });
          }
          const admission = await Promise.race([
            waitForQuiescenceMutationAdmission().then((allowed) => ({
              kind: "admission" as const,
              allowed,
            })),
            tracked.permitSignal.then(() => ({ kind: "permit" as const })),
          ]);
          if (admission.kind === "permit") continue;
          if (!admission.allowed) return false;
        }
        if (!isCurrent()) return false;
        tracked.grantQuiescencePermit();
        tracked.admitted = true;
        return await executeDeferredArchive();
      },
    );
    async function executeDeferredArchive(): Promise<boolean> {
      failureRevisionAtStart = fileEventFailureRevision;
      try {
        if (!isCurrent()) return false;
        const still = await findNodeByUri(capturedUri, projectId, isCurrent);
        if (!still || still.archivedAt) return true;
        assertMountAuthorityCurrent(isCurrent);
        await softArchiveNode(still.id);
        assertMountAuthorityCurrent(isCurrent);
        await useTreeStore
          .getState()
          .loadTree(projectId, workspaceOpenRevision);
        assertMountAuthorityCurrent(isCurrent);
        // dirty 経路と違いトーストを出さないため SR へ通知 (WCAG 4.1.3)。
        announce(
          i18next.t("externalMount.a11y.fileArchived", {
            name: basename(relPath),
            defaultValue:
              "外部で削除されたファイル「{{name}}」をアーカイブしました",
          }),
        );
        return true;
      } catch (err) {
        if (!(err instanceof ExternalMountAuthoritySupersededError)) throw err;
        return false;
      }
    }
    const completedArchiveTask = archiveTask
      .then((reconciled) => {
        if (reconciled) {
          clearFileEventFailures(keys, failureRevisionAtStart);
        }
      })
      .catch((error: unknown) => {
        recordFileEventFailure(keys, error, isCurrent);
        throw error;
      });
    extendRootFileEventChain(root.id, authorityToken, completedArchiveTask);
    activeFileEvents.set(completedArchiveTask, tracked);
    void completedArchiveTask
      .catch((error: unknown) => {
        debugLog.error(
          "ExternalMount",
          "Deferred external archive failed",
          errorDetail(error),
        );
      })
      .finally(() => activeFileEvents.delete(completedArchiveTask));
  }, RENAME_WINDOW_MS);
  pendingArchives.push({ rootId: root.id, relPath, timer });
}

async function handleFileRenamed(
  root: ExternalRoot,
  oldRelPath: string,
  newRelPath: string,
  projectId: string,
  isCurrent: MountAuthorityGuard,
  workspaceOpenRevision?: number,
  markRootWide: () => void = () => {},
  markFailurePath: (relPath: string) => void = () => {},
): Promise<FileEventReconciliation> {
  assertMountAuthorityCurrent(isCurrent);
  cancelPendingArchive(root.id, oldRelPath);
  cancelPendingArchive(root.id, newRelPath);
  const oldUri = buildSourceUri(root.id, oldRelPath);
  assertMountAuthorityCurrent(isCurrent);
  const nodes = await listAllNodes(projectId);
  assertMountAuthorityCurrent(isCurrent);
  const node = nodes.find((candidate) => candidate.sourceUri === oldUri);
  if (!node) {
    return await handleFileAdded(
      root,
      newRelPath,
      projectId,
      isCurrent,
      workspaceOpenRevision,
      markRootWide,
      markFailurePath,
      false,
    );
  }
  const newUri = buildSourceUri(root.id, newRelPath);
  let parentId = node.parentId;
  if (dirname(oldRelPath) !== dirname(newRelPath)) {
    const newParentRel = dirname(newRelPath);
    const newParentUri =
      newParentRel === null
        ? buildMountFolderUri(root.id)
        : buildSourceUri(root.id, newParentRel);
    const newParent = nodes.find(
      (candidate) =>
        candidate.nodeType === "folder" &&
        candidate.sourceUri === newParentUri &&
        !candidate.archivedAt,
    );
    if (!newParent) {
      return await handleFileAdded(
        root,
        newRelPath,
        projectId,
        isCurrent,
        workspaceOpenRevision,
        markRootWide,
        markFailurePath,
        false,
      );
    }
    parentId = newParent.id;
  }
  assertMountAuthorityCurrent(isCurrent);
  await updateNode(node.id, {
    sourceUri: newUri,
    title: titleFromFilename(basename(newRelPath)),
    parentId,
    sortOrder: sortOrderForFilename(newRelPath),
  });
  assertMountAuthorityCurrent(isCurrent);
  await useTreeStore.getState().loadTree(projectId, workspaceOpenRevision);
  assertMountAuthorityCurrent(isCurrent);
  toast.info(
    i18next.t("externalMount.toast.renamed", {
      title: titleFromFilename(basename(newRelPath)),
    }),
  );
  return {
    kind: "paths",
    keys: new Set([
      externalPathKey(root.id, oldRelPath),
      externalPathKey(root.id, newRelPath),
    ]),
  };
}

async function findNodeByUri(
  uri: string,
  projectId = getCurrentProjectId(),
  isCurrent: MountAuthorityGuard = () => true,
) {
  assertMountAuthorityCurrent(isCurrent);
  const nodes = await listAllNodes(projectId);
  assertMountAuthorityCurrent(isCurrent);
  return nodes.find((n) => n.sourceUri === uri);
}

/** @internal Exported for unit tests. */
export { applyExternalContent };

export async function resolveReloadConflict(
  choice: "keep-local" | "reload",
): Promise<void> {
  const conflict = useExternalRootStore.getState().conflicts[0];
  if (!conflict) return;
  if (choice === "reload") {
    if (!canScheduleQuiescenceMutation()) return;
    const documentKey: DocumentKey = {
      kind: "tree",
      id: conflict.sceneId,
      storage: "file",
    };

    // runExclusiveDocumentMutation publishes the read-only lease
    // synchronously but invokes its callback in a microtask behind every
    // already-issued local save. Use that synchronous window to cancel live
    // debounce drafts immediately, before they can become another save.
    let initialWriteBackCancellation: Promise<void> = Promise.resolve();
    const reload = runExclusiveDocumentMutation(
      documentKey,
      async ({ markAuthoritativeMutation }) => {
        await initialWriteBackCancellation;
        // A save already running when the user chose Reload can persist and
        // schedule OUT after the first cancellation snapshot. Drain the DB
        // chain, discard any failure/pending state it left on the live
        // AutoSave, then cancel OUT again to a fixed point.
        await awaitPendingSceneContentWrite(conflict.sceneId);
        discardAutoSavesForDocument(documentKey);
        discardRegisteredDocumentDrafts(documentKey);
        await cancelWriteBack(conflict.sceneId);
        await awaitPendingSceneContentWrite(conflict.sceneId);
        await cancelWriteBack(conflict.sceneId);

        // The disk version is now the explicit winner. Muting prevents this
        // restorative write from re-entering the watcher as another conflict.
        useExternalRootStore
          .getState()
          .mutePath(conflict.rootId, conflict.relPath);
        await mountApi.writeExternalFile(
          conflict.rootId,
          conflict.relPath,
          conflict.incomingContent,
        );
        await applyExternalContent(
          conflict.sceneId,
          conflict.rootId,
          conflict.relPath,
          conflict.incomingContent,
          conflict.incomingMtime,
          getCurrentProjectId(),
          () => true,
          undefined,
          markAuthoritativeMutation,
        );
      },
    );
    discardAutoSavesForDocument(documentKey);
    discardRegisteredDocumentDrafts(documentKey);
    initialWriteBackCancellation = cancelWriteBack(conflict.sceneId);
    await reload;
  }
  useExternalRootStore.getState().shiftConflict();
}
