/**
 * Exact renderer-local publication emitted after a scene body has committed.
 *
 * This deliberately stays independent from React/Zustand. The editor save
 * path can publish at the database commit boundary, while read-only consumers
 * such as Chronicle subscribe without creating a feature-store import cycle.
 */
export interface SceneBodyCommitPublication {
  workspacePath: string;
  openRevision: number;
  projectId: string;
  sceneId: string;
  contentVersion: number;
}

type SceneBodyCommitListener = (
  publication: SceneBodyCommitPublication,
) => void;

const listeners = new Set<SceneBodyCommitListener>();

export function publishSceneBodyCommit(
  publication: SceneBodyCommitPublication,
): void {
  for (const listener of [...listeners]) listener(publication);
}

export function subscribeSceneBodyCommits(
  listener: SceneBodyCommitListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** @internal */
export function _resetSceneBodyCommitRegistryForTests(): void {
  listeners.clear();
}
