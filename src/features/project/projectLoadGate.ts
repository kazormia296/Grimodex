let loadDepth = 0;
const waiters: Array<() => void> = [];
let workspaceLease: symbol | null = null;
const workspaceLeaseWaiters: Array<() => void> = [];
const activeLoadContexts = new Set<symbol>();

export interface WorkspaceProjectLoadLease {
  /**
   * Re-entrant context owned by the Workspace replacement. It is the only
   * context allowed to hydrate the replacement Project while ordinary Project
   * loads remain excluded.
   */
  readonly projectLoadContext: ProjectLoadContext;
  release: () => void;
}

export interface ProjectLoadContext {
  readonly token: symbol;
  readonly owner: "project" | "workspace";
  active: boolean;
}

export function isProjectLoading(): boolean {
  return loadDepth > 0;
}

function waitForWorkspaceLeaseRelease(): Promise<void> {
  return new Promise<void>((resolve) => {
    workspaceLeaseWaiters.push(resolve);
  });
}

export async function withProjectLoad<T>(
  fn: (context: ProjectLoadContext) => Promise<T>,
  existingContext?: ProjectLoadContext,
): Promise<T> {
  if (existingContext) {
    if (
      !existingContext.active ||
      !activeLoadContexts.has(existingContext.token)
    ) {
      throw new Error("Project load context is no longer active");
    }
    return fn(existingContext);
  }
  // The check and increment are intentionally synchronous after the await.
  // A Workspace lease can therefore either observe this load in `loadDepth`,
  // or make it wait here; no load can slip between both states.
  while (workspaceLease !== null) await waitForWorkspaceLeaseRelease();
  const context: ProjectLoadContext = {
    token: Symbol("project-load-context"),
    owner: "project",
    active: true,
  };
  activeLoadContexts.add(context.token);
  loadDepth++;
  try {
    return await fn(context);
  } finally {
    context.active = false;
    activeLoadContexts.delete(context.token);
    loadDepth--;
    if (loadDepth === 0) {
      for (const resolve of waiters.splice(0)) {
        resolve();
      }
    }
  }
}

export function whenProjectLoadDone(): Promise<void> {
  if (loadDepth === 0) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/**
 * Excludes new Project loads, invalidates every already-running generation,
 * then waits for the complete Project load operation to leave the gate.
 * The caller must hold the returned lease through the native Workspace swap
 * and initial Project identity publication.
 */
export async function acquireWorkspaceProjectLoadLease(
  invalidateProjectLoads: () => void,
): Promise<WorkspaceProjectLoadLease> {
  while (workspaceLease !== null) await waitForWorkspaceLeaseRelease();
  const token = Symbol("workspace-project-load-lease");
  workspaceLease = token;
  try {
    invalidateProjectLoads();
    await whenProjectLoadDone();
  } catch (error) {
    if (workspaceLease === token) {
      workspaceLease = null;
      for (const resolve of workspaceLeaseWaiters.splice(0)) resolve();
    }
    throw error;
  }

  // Keep the Workspace lease represented in loadDepth as well. This makes
  // whenProjectLoadDone() cover the replacement hydrate and prevents queued
  // Project loads from observing an artificial idle gap before identity
  // publication.
  const projectLoadContext: ProjectLoadContext = {
    token: Symbol("workspace-project-load-context"),
    owner: "workspace",
    active: true,
  };
  activeLoadContexts.add(projectLoadContext.token);
  loadDepth++;

  let released = false;
  return {
    projectLoadContext,
    release() {
      if (released) return;
      released = true;
      projectLoadContext.active = false;
      if (activeLoadContexts.delete(projectLoadContext.token)) loadDepth--;
      if (workspaceLease !== token) return;
      workspaceLease = null;
      if (loadDepth === 0) {
        for (const resolve of waiters.splice(0)) resolve();
      }
      for (const resolve of workspaceLeaseWaiters.splice(0)) resolve();
    },
  };
}

/** Test helper */
export function resetProjectLoadGateForTests(): void {
  loadDepth = 0;
  waiters.length = 0;
  activeLoadContexts.clear();
  workspaceLease = null;
  for (const resolve of workspaceLeaseWaiters.splice(0)) resolve();
}
