/** Renderer-local identity of the database currently bound to this window. */
export interface WorkspaceIdentity {
  path: string;
  openRevision: number;
}

let currentIdentity: WorkspaceIdentity | null = null;

export function setCurrentWorkspaceIdentity(
  identity: WorkspaceIdentity | null,
): void {
  currentIdentity = identity ? { ...identity } : null;
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
