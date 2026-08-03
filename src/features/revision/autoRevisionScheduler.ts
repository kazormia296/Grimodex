import {
  cancelEditorAnalysisTask,
  scheduleEditorAnalysisTask,
} from "@/lib/editorAnalysisScheduler";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { markEnd, markStart, recordCounter } from "@/lib/perfLog";
import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";
import {
  getCurrentWorkspaceIdentity,
  isCurrentWorkspaceIdentity,
  type WorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { useTreeStore } from "@/features/tree/treeStore";
import { createRevision, pruneRevisions } from "./api";
import { useRevisionStore } from "./revisionStore";

export interface AutoRevisionRequest {
  workspaceIdentity: WorkspaceIdentity | null;
  projectId: string;
  sceneId: string;
  contentVersion: number;
  contentJson: string;
  intervalMs: number;
  keepCount: number;
}

const pending = new Map<string, AutoRevisionRequest>();
const running = new Map<string, Promise<void>>();
const completedVersion = new Map<string, number>();

function requestKey(request: AutoRevisionRequest): string {
  return JSON.stringify([
    request.workspaceIdentity?.path ?? null,
    request.workspaceIdentity?.openRevision ?? null,
    request.projectId,
    request.sceneId,
  ]);
}

function schedulerKey(key: string): string {
  return `auto-revision:${key}`;
}

function isAuthoritative(request: AutoRevisionRequest): boolean {
  const sameWorkspace = request.workspaceIdentity
    ? isCurrentWorkspaceIdentity(request.workspaceIdentity)
    : getCurrentWorkspaceIdentity() === null;
  return (
    sameWorkspace && useTreeStore.getState().projectId === request.projectId
  );
}

function schedulePendingKey(key: string): void {
  scheduleEditorAnalysisTask({
    key: schedulerKey(key),
    kind: "revision",
    delayMs: 0,
    run: () => runAutoRevision(key),
    onError: (error) => {
      debugLog.warn(
        "AutoSave",
        "revision failed (content saved)",
        errorDetail(error),
      );
    },
  });
}

async function runAutoRevision(key: string): Promise<void> {
  const existing = running.get(key);
  if (existing) return existing;

  const request = pending.get(key);
  pending.delete(key);
  if (!request) return;

  const task = (async () => {
    recordCounter("editor.postSave.autoRevision.started");
    markStart("editor.postSave.autoRevision");
    try {
      if (!isAuthoritative(request)) return;
      if ((completedVersion.get(key) ?? -1) >= request.contentVersion) return;

      const revision = await createRevision({
        entityType: "scene",
        entityId: request.sceneId,
        content: request.contentJson,
        snapshotType: "auto",
      });
      if (!isAuthoritative(request)) return;
      completedVersion.set(key, request.contentVersion);
      if (!revision) return;
      useRevisionStore.getState().recordAutoRevision(key);
      await pruneRevisions("scene", request.sceneId, request.keepCount);
    } catch (error) {
      // Revisions are non-critical follow-up work. In particular, a
      // Workspace/Project lifecycle closes read admission before strict
      // quiescence drains this queue, so the latest-revision lookup can be
      // cancelled deliberately. The durable scene save has already succeeded;
      // do not turn that expected cancellation into a failed scope change.
      debugLog.warn(
        "AutoSave",
        "revision failed (content saved)",
        errorDetail(error),
      );
    } finally {
      recordCounter("editor.postSave.autoRevision.settled");
      markEnd("editor.postSave.autoRevision");
    }
  })();
  running.set(key, task);
  try {
    await task;
  } finally {
    if (running.get(key) === task) running.delete(key);
    if (pending.has(key)) schedulePendingKey(key);
  }
}

/**
 * Queue a revision for the exact durable scene snapshot.
 *
 * Requests are latest-wins per workspace/project/scene. They run outside the
 * durable save path, while quiescence still flushes them before scope changes.
 */
export function scheduleAutoRevision(request: AutoRevisionRequest): boolean {
  const key = requestKey(request);
  if (
    !useRevisionStore.getState().shouldAutoRevision(key, request.intervalMs)
  ) {
    return false;
  }
  const current = pending.get(key);
  if (current && current.contentVersion > request.contentVersion) return false;
  pending.set(key, request);
  recordCounter("editor.postSave.autoRevision.scheduled");
  if (!running.has(key)) schedulePendingKey(key);
  return true;
}

async function flushAutoRevisions(): Promise<void> {
  for (;;) {
    for (const key of pending.keys()) {
      cancelEditorAnalysisTask(schedulerKey(key));
      if (!running.has(key)) void runAutoRevision(key);
    }
    const active = [...running.values()];
    if (active.length > 0) await Promise.all(active);
    if (pending.size === 0 && running.size === 0) return;
  }
}

/** @internal */
export function _resetAutoRevisionSchedulerForTests(): void {
  for (const key of pending.keys()) {
    cancelEditorAnalysisTask(schedulerKey(key));
  }
  pending.clear();
  running.clear();
  completedVersion.clear();
}

registerQuiescenceProvider({
  id: "scene-auto-revisions",
  stage: "scoped-mutations",
  flush: flushAutoRevisions,
  discard: _resetAutoRevisionSchedulerForTests,
});
