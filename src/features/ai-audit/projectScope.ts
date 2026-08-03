import { useWorkspaceStore } from "@/features/workspace/store";

/** Fail closed before an AI transport can dispatch without project authority. */
export function requireAuditProjectId(
  projectId: string | null | undefined,
): string {
  const normalized = projectId?.trim();
  if (!normalized) {
    throw new Error("AI audit requires a project before AI dispatch");
  }
  return normalized;
}

/**
 * Immutable authority for one user-triggered AI operation.
 *
 * Callers must create this synchronously, before their first await. The
 * authority is then passed through every async context instead of allowing a
 * later store read to silently retarget the operation to another project.
 */
export interface AiOperationAuthority {
  readonly projectId: string;
  readonly expectedWorkspacePath: string;
  readonly resourceId: string;
  readonly operationId: string;
}

export function captureAiOperationAuthority(
  projectId: string | null | undefined,
  resourceId: string,
): AiOperationAuthority {
  const normalizedProjectId = requireAuditProjectId(projectId);
  const normalizedResourceId = resourceId.trim();
  if (!normalizedResourceId) {
    throw new Error("AI audit requires a resource before AI dispatch");
  }
  const { activeWorkspacePath, workspaceSwitchInProgress } =
    useWorkspaceStore.getState();
  if (
    workspaceSwitchInProgress ||
    typeof activeWorkspacePath !== "string" ||
    !activeWorkspacePath.trim()
  ) {
    throw new Error(
      "AI audit requires a stable active workspace before AI dispatch",
    );
  }
  return {
    projectId: normalizedProjectId,
    expectedWorkspacePath: activeWorkspacePath,
    resourceId: normalizedResourceId,
    operationId: crypto.randomUUID(),
  };
}

/** Convert captured authority into the renderer transport context. */
export function aiAuditContextForOperation(
  authority: AiOperationAuthority,
  pathId: string,
): {
  projectId: string;
  expectedWorkspacePath: string;
  operationId: string;
  pathId: string;
  metadata: { operationScopeId: string };
} {
  return {
    projectId: authority.projectId,
    expectedWorkspacePath: authority.expectedWorkspacePath,
    operationId: authority.operationId,
    pathId,
    metadata: { operationScopeId: authority.resourceId },
  };
}

/** Prevent an async result from mutating a replacement workspace/project. */
export function assertAiOperationAuthorityCurrent(
  authority: AiOperationAuthority,
  currentProjectId: string | null | undefined,
): void {
  const { activeWorkspacePath, workspaceSwitchInProgress } =
    useWorkspaceStore.getState();
  if (
    workspaceSwitchInProgress ||
    activeWorkspacePath !== authority.expectedWorkspacePath ||
    requireAuditProjectId(currentProjectId) !== authority.projectId
  ) {
    throw new Error(
      "AI operation authority changed before its result could be applied",
    );
  }
}
