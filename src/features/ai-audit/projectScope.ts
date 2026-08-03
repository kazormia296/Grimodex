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
