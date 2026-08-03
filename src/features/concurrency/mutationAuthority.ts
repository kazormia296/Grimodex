import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";

export interface MutationAuthority {
  projectId: string;
  currentProjectId: () => string;
  workspacePath: string | null;
  workspaceOpenRevision: number | null;
}

export type MutationOutcome<T> =
  | { status: "current"; value: T }
  | { status: "stale"; value?: T };

const pendingMutations = new Set<Promise<unknown>>();

export function captureMutationAuthority(
  projectId: string,
  currentProjectId: () => string,
): MutationAuthority {
  const workspace = getCurrentWorkspaceIdentity();
  return {
    projectId,
    currentProjectId,
    workspacePath: workspace?.path ?? null,
    workspaceOpenRevision: workspace?.openRevision ?? null,
  };
}

export function isCurrentMutationAuthority(
  authority: MutationAuthority,
): boolean {
  const workspace = getCurrentWorkspaceIdentity();
  return (
    authority.currentProjectId() === authority.projectId &&
    (workspace?.path ?? null) === authority.workspacePath &&
    (workspace?.openRevision ?? null) === authority.workspaceOpenRevision
  );
}

/**
 * Tracks the real persistence task so Workspace/Project quiescence cannot
 * replace authority while it is still running. A stale completion is a
 * committed-old-scope outcome, not a retryable failure.
 */
export async function runAuthoritativeMutation<T>(
  authority: MutationAuthority,
  mutation: () => Promise<T>,
  options?: { preexistingDraft?: boolean },
): Promise<MutationOutcome<T>> {
  if (
    !canScheduleQuiescenceMutation(options) ||
    !isCurrentMutationAuthority(authority)
  ) {
    return { status: "stale" };
  }
  // Mutation creation stays synchronous so optimistic UI callers can rely on
  // the underlying IPC being leased before this function yields.
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(mutation());
  } catch (error) {
    pending = Promise.reject(error);
  }
  pendingMutations.add(pending);
  try {
    const value = await pending;
    return isCurrentMutationAuthority(authority)
      ? { status: "current", value }
      : { status: "stale", value };
  } finally {
    pendingMutations.delete(pending);
  }
}

export async function awaitPendingAuthoritativeMutations(): Promise<void> {
  const failures: unknown[] = [];
  while (pendingMutations.size > 0) {
    const results = await Promise.allSettled([...pendingMutations]);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more scoped mutations failed");
  }
}

registerQuiescenceProvider({
  id: "authoritative-mutations",
  stage: "scoped-mutations",
  flush: awaitPendingAuthoritativeMutations,
});

export function _resetMutationAuthorityForTests(): void {
  pendingMutations.clear();
}
