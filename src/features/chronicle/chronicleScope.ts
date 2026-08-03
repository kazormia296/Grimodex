/**
 * Exact renderer-local ownership boundary for Chronicle state.
 *
 * projectId is not globally unique across workspace databases. openRevision
 * also participates because reseed/restore can replace the database while
 * reopening the same filesystem path.
 */
export interface ChronicleScope {
  workspacePath: string;
  openRevision: number;
  projectId: string;
}

export type ChronicleScopeKey = string;

/**
 * Collision-free serialized identity. Do not normalize workspacePath here:
 * it must match the workspace identity that was used to open the database.
 */
export function chronicleScopeKey(scope: ChronicleScope): ChronicleScopeKey {
  return JSON.stringify([
    scope.workspacePath,
    scope.openRevision,
    scope.projectId,
  ]);
}

export function isSameChronicleScope(
  left: ChronicleScope | null,
  right: ChronicleScope | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.workspacePath === right.workspacePath &&
    left.openRevision === right.openRevision &&
    left.projectId === right.projectId
  );
}
