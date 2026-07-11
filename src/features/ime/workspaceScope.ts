/** Renderer-local identity of the database currently bound to this window. */
export interface ImeWorkspaceIdentity {
  path: string;
  openRevision: number;
}

let currentIdentity: ImeWorkspaceIdentity | null = null;

export function setCurrentImeWorkspaceIdentity(
  identity: ImeWorkspaceIdentity | null,
): void {
  currentIdentity = identity ? { ...identity } : null;
}

export function getCurrentImeWorkspaceIdentity(): ImeWorkspaceIdentity | null {
  return currentIdentity ? { ...currentIdentity } : null;
}

export function isCurrentImeWorkspaceIdentity(
  identity: ImeWorkspaceIdentity,
): boolean {
  return (
    currentIdentity?.path === identity.path &&
    currentIdentity.openRevision === identity.openRevision
  );
}
