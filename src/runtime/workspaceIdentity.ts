/** Renderer-local identity of the database currently bound to this window. */
export interface WorkspaceIdentity {
  path: string;
  openRevision: number;
}

let currentIdentity: WorkspaceIdentity | null = null;
const listeners = new Set<(identity: WorkspaceIdentity | null) => void>();

export function setCurrentWorkspaceIdentity(
  identity: WorkspaceIdentity | null,
): void {
  currentIdentity = identity ? { ...identity } : null;
  const published = getCurrentWorkspaceIdentity();
  for (const listener of [...listeners]) listener(published);
}

export function getCurrentWorkspaceIdentity(): WorkspaceIdentity | null {
  return currentIdentity ? { ...currentIdentity } : null;
}

export function isCurrentWorkspaceIdentity(
  identity: WorkspaceIdentity,
): boolean {
  return (
    currentIdentity?.path === identity.path &&
    currentIdentity.openRevision === identity.openRevision
  );
}

export function subscribeCurrentWorkspaceIdentity(
  listener: (identity: WorkspaceIdentity | null) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
