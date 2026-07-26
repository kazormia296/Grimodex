import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import {
  getCurrentProjectLanguage,
  useProjectStore,
} from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  chatIndexStatus,
  chatReindexAll,
  codexIndexStatus,
  codexReindexAll,
  downloadSemanticModel,
  eventsIndexStatus,
  eventsReindexAll,
  semanticIndexStatus,
  semanticReindexAll,
} from "./api";
import {
  createReindexRunId,
  useReindexProgressStore,
} from "./reindexProgressStore";

/**
 * Identity captured before an async indexing flow starts. Project ids are only
 * unique inside one workspace (`default-project` is deliberately reused), so
 * every guard and stale-result check must include the workspace path.
 */
export interface SemanticIndexScope {
  workspaceKey: string;
  workspaceOpenRevision: number;
  projectId: string;
  guardKey: string;
}

function makeGuardKey(
  workspaceKey: string,
  workspaceOpenRevision: number,
  projectId: string,
): string {
  return JSON.stringify([workspaceKey, workspaceOpenRevision, projectId]);
}

/** Capture a nullable, fully initialized current scope. */
export function captureCurrentSemanticScope(
  expectedProjectId?: string,
  expectedWorkspaceKey?: string,
): SemanticIndexScope | null {
  if (
    useWorkspaceStore.getState().workspaceSwitchInProgress ||
    !useWorkspaceStore.getState().workspaceHydrated
  ) {
    return null;
  }
  const currentWorkspaceKey =
    useWorkspaceStore.getState().activeWorkspacePath ?? null;
  if (
    expectedWorkspaceKey != null &&
    expectedWorkspaceKey !== currentWorkspaceKey
  ) {
    return null;
  }
  const workspaceKey = expectedWorkspaceKey ?? currentWorkspaceKey;
  const workspaceOpenRevision =
    useWorkspaceStore.getState().workspaceOpenRevision;
  const currentProjectId = useProjectStore.getState().currentProjectId;
  const projectId = expectedProjectId ?? currentProjectId;
  if (!workspaceKey || !projectId || currentProjectId !== projectId)
    return null;
  return {
    workspaceKey,
    workspaceOpenRevision,
    projectId,
    guardKey: makeGuardKey(workspaceKey, workspaceOpenRevision, projectId),
  };
}

/** Re-check a captured scope after every await before starting the next stage. */
export function isSemanticScopeCurrent(scope: SemanticIndexScope): boolean {
  return (
    useWorkspaceStore.getState().workspaceHydrated &&
    !useWorkspaceStore.getState().workspaceSwitchInProgress &&
    useWorkspaceStore.getState().activeWorkspacePath === scope.workspaceKey &&
    useWorkspaceStore.getState().workspaceOpenRevision ===
      scope.workspaceOpenRevision &&
    useProjectStore.getState().currentProjectId === scope.projectId
  );
}

const codexAttempted = new Set<string>();
const eventsAttempted = new Set<string>();
const chatAttempted = new Set<string>();
const sceneAttempted = new Set<string>();
const modelAttempted = new Set<string>();

let activeScopeGuardKey: string | null = null;

/**
 * Activate the App-level scope. A real workspace/project switch clears the
 * foreground run token and toast exactly once; React StrictMode's duplicate
 * effect for the same identity is a no-op.
 */
export function activateSemanticIndexScope(
  workspaceKey: string,
  projectId: string,
  workspaceOpenRevision = useWorkspaceStore.getState().workspaceOpenRevision,
): void {
  const next = makeGuardKey(workspaceKey, workspaceOpenRevision, projectId);
  if (activeScopeGuardKey === next) return;
  activeScopeGuardKey = next;
  useReindexProgressStore.getState().clear();
}

function captureScope(
  projectId: string,
  workspaceKey?: string,
): SemanticIndexScope | null {
  if (!projectId) return null;
  return captureCurrentSemanticScope(projectId, workspaceKey);
}

/**
 * Release a once-per-session guard when an awaited result belongs to a scope
 * that is no longer active. Without this, A -> B -> A can permanently skip A:
 * the stale A task stops correctly, but leaves its `attempted` entry behind.
 */
function stopStaleAttempt(
  scope: SemanticIndexScope,
  attempted: Set<string>,
): boolean {
  if (isSemanticScopeCurrent(scope)) return false;
  attempted.delete(scope.guardKey);
  return true;
}

/** Wait for the foreground scene reindex slot without polling. */
function waitForSceneReindexIdle(): Promise<void> {
  if (!useReindexProgressStore.getState().running) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useReindexProgressStore.subscribe((state) => {
      if (!state.running) {
        unsubscribe();
        resolve();
      }
    });
    // Close the check-to-subscribe race if the active run finished between
    // the fast-path read above and listener registration.
    if (!useReindexProgressStore.getState().running) {
      unsubscribe();
      resolve();
    }
  });
}

/** Ensure the current project's embedding model, once per workspace/project. */
export async function ensureSemanticModelForProject(
  projectId: string,
  workspaceKey?: string,
): Promise<void> {
  const scope = captureScope(projectId, workspaceKey);
  if (!scope || modelAttempted.has(scope.guardKey)) return;
  modelAttempted.add(scope.guardKey);
  try {
    const language = getCurrentProjectLanguage();
    const status = await downloadSemanticModel(language);
    if (stopStaleAttempt(scope, modelAttempted)) return;
    debugLog.info("semantic-search", `model ensure (${language}): ${status}`);
  } catch (e) {
    modelAttempted.delete(scope.guardKey);
    if (!isSemanticScopeCurrent(scope)) return;
    debugLog.warn(
      "semantic-search",
      `model ensure skipped: ${projectId}`,
      errorDetail(e),
    );
  }
}

/** Backfill Codex entries that predate incremental semantic indexing. */
export async function ensureCodexIndexed(
  projectId: string,
  workspaceKey?: string,
): Promise<void> {
  const scope = captureScope(projectId, workspaceKey);
  if (!scope || codexAttempted.has(scope.guardKey)) return;
  codexAttempted.add(scope.guardKey);
  try {
    const status = await codexIndexStatus(projectId);
    if (stopStaleAttempt(scope, codexAttempted)) return;
    if (status.indexedEntryCount >= status.totalEntryCount) return;
    debugLog.info(
      "semantic-search",
      `codex auto back-index: ${status.indexedEntryCount}/${status.totalEntryCount} → reindexing`,
    );
    const n = await codexReindexAll(projectId);
    if (stopStaleAttempt(scope, codexAttempted)) return;
    debugLog.info(
      "semantic-search",
      `codex auto back-index done: ${n} vectors`,
    );
  } catch (e) {
    codexAttempted.delete(scope.guardKey);
    if (!isSemanticScopeCurrent(scope)) return;
    debugLog.warn(
      "semantic-search",
      `codex auto back-index skipped: ${projectId}`,
      errorDetail(e),
    );
  }
}

/** Backfill Chronicle events; search_events is dense-only, so this is required. */
export async function ensureEventsIndexed(
  projectId: string,
  workspaceKey?: string,
): Promise<void> {
  const scope = captureScope(projectId, workspaceKey);
  if (!scope || eventsAttempted.has(scope.guardKey)) return;
  eventsAttempted.add(scope.guardKey);
  try {
    const status = await eventsIndexStatus(projectId);
    if (stopStaleAttempt(scope, eventsAttempted)) return;
    if (status.indexedEventCount >= status.totalEventCount) return;
    debugLog.info(
      "semantic-search",
      `events auto back-index: ${status.indexedEventCount}/${status.totalEventCount} → reindexing`,
    );
    const n = await eventsReindexAll(projectId);
    if (stopStaleAttempt(scope, eventsAttempted)) return;
    debugLog.info(
      "semantic-search",
      `events auto back-index done: ${n} vectors`,
    );
  } catch (e) {
    eventsAttempted.delete(scope.guardKey);
    if (!isSemanticScopeCurrent(scope)) return;
    debugLog.warn(
      "semantic-search",
      `events auto back-index skipped: ${projectId}`,
      errorDetail(e),
    );
  }
}

/** Backfill existing chat messages for episodic recall. */
export async function ensureChatIndexed(
  projectId: string,
  workspaceKey?: string,
): Promise<void> {
  const scope = captureScope(projectId, workspaceKey);
  if (!scope || chatAttempted.has(scope.guardKey)) return;
  chatAttempted.add(scope.guardKey);
  try {
    const status = await chatIndexStatus(projectId);
    if (stopStaleAttempt(scope, chatAttempted)) return;
    if (status.indexedMessageCount >= status.totalMessageCount) return;
    debugLog.info(
      "semantic-search",
      `chat auto back-index: ${status.indexedMessageCount}/${status.totalMessageCount} → reindexing`,
    );
    const n = await chatReindexAll(projectId);
    if (stopStaleAttempt(scope, chatAttempted)) return;
    debugLog.info("semantic-search", `chat auto back-index done: ${n} vectors`);
  } catch (e) {
    chatAttempted.delete(scope.guardKey);
    if (!isSemanticScopeCurrent(scope)) return;
    debugLog.warn(
      "semantic-search",
      `chat auto back-index skipped: ${projectId}`,
      errorDetail(e),
    );
  }
}

/** Backfill and refresh prose chunks, with a renderer-owned run token. */
export async function ensureSceneIndexed(
  projectId: string,
  workspaceKey?: string,
): Promise<void> {
  const scope = captureScope(projectId, workspaceKey);
  if (!scope || sceneAttempted.has(scope.guardKey)) return;
  if (useReindexProgressStore.getState().running) {
    await waitForSceneReindexIdle();
    if (!isSemanticScopeCurrent(scope)) return;
    // Re-enter after the slot opens: another waiter may have claimed it first,
    // and resetIndexGuards may have changed the once-per-session guard while
    // the previous language/model run was still active.
    return ensureSceneIndexed(projectId, scope.workspaceKey);
  }
  sceneAttempted.add(scope.guardKey);

  let runId: string | null = null;
  try {
    const status = await semanticIndexStatus(projectId);
    if (stopStaleAttempt(scope, sceneAttempted)) return;
    const incomplete =
      status.indexedSceneCount < status.nonemptySceneCount ||
      status.staleChunkCount > 0;
    if (!incomplete) return;

    const progress = useReindexProgressStore.getState();
    if (progress.running) {
      sceneAttempted.delete(scope.guardKey);
      return;
    }
    runId = createReindexRunId();
    if (
      !progress.begin(
        scope.workspaceKey,
        scope.workspaceOpenRevision,
        projectId,
        runId,
      )
    ) {
      sceneAttempted.delete(scope.guardKey);
      return;
    }

    debugLog.info(
      "semantic-search",
      `scene auto back-index: ${status.indexedSceneCount}/${status.nonemptySceneCount} indexable, stale=${status.staleChunkCount} → reindexing`,
    );
    const n = await semanticReindexAll(projectId, runId);
    if (stopStaleAttempt(scope, sceneAttempted)) return;
    debugLog.info("semantic-search", `scene auto back-index done: ${n} chunks`);
  } catch (e) {
    sceneAttempted.delete(scope.guardKey);
    if (runId) useReindexProgressStore.getState().fail(runId);
    if (!isSemanticScopeCurrent(scope)) return;
    debugLog.warn(
      "semantic-search",
      `scene auto back-index skipped: ${projectId}`,
      errorDetail(e),
    );
  } finally {
    if (runId) useReindexProgressStore.getState().finish(runId);
  }
}

/**
 * Main-window coordinator. Every stage re-checks the captured workspace and
 * project before starting the next one, so A cannot continue into B after a
 * workspace swap even when both use `default-project`.
 */
export async function ensureSemanticIndexesOnOpen(
  projectId: string,
  workspaceKey?: string,
): Promise<void> {
  if (isPanelWindow()) return;
  const scope = captureScope(projectId, workspaceKey);
  if (!scope) return;
  activateSemanticIndexScope(
    scope.workspaceKey,
    scope.projectId,
    scope.workspaceOpenRevision,
  );

  await ensureSemanticModelForProject(projectId, scope.workspaceKey);
  if (!isSemanticScopeCurrent(scope)) return;
  await ensureCodexIndexed(projectId, scope.workspaceKey);
  if (!isSemanticScopeCurrent(scope)) return;
  await ensureEventsIndexed(projectId, scope.workspaceKey);
  if (!isSemanticScopeCurrent(scope)) return;
  await ensureChatIndexed(projectId, scope.workspaceKey);
  if (!isSemanticScopeCurrent(scope)) return;
  await ensureSceneIndexed(projectId, scope.workspaceKey);
}

/** Reset this workspace/project's once-per-session guards after language change. */
export function resetIndexGuards(
  projectId: string,
  workspaceKey?: string,
): void {
  const scope = captureScope(projectId, workspaceKey);
  if (!scope) return;
  clearBackIndexGuards(scope);
  modelAttempted.delete(scope.guardKey);
}

function clearBackIndexGuards(scope: SemanticIndexScope): void {
  codexAttempted.delete(scope.guardKey);
  eventsAttempted.delete(scope.guardKey);
  chatAttempted.delete(scope.guardKey);
  sceneAttempted.delete(scope.guardKey);
}

/**
 * Re-run domain status checks after an asynchronous model download completes.
 * The model guard intentionally remains: the successful completion event is
 * already proof that this scope's model ensure has finished.
 */
export function resetBackIndexGuards(
  projectId: string,
  workspaceKey?: string,
): void {
  const scope = captureScope(projectId, workspaceKey);
  if (scope) clearBackIndexGuards(scope);
}

/** Test-only reset of module-level guards and the active coordinator scope. */
export function _resetAutoIndexForTests(): void {
  codexAttempted.clear();
  eventsAttempted.clear();
  chatAttempted.clear();
  sceneAttempted.clear();
  modelAttempted.clear();
  activeScopeGuardKey = null;
  useReindexProgressStore.getState().clear();
}
