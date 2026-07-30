export const FALLBACK_PROJECT_ID = "default-project";

let currentProjectId: string | null = null;

/**
 * Publish the current Project identity independently from the Zustand UI
 * projection. Cross-feature services can capture authority without importing
 * the concrete Project store.
 */
export function publishCurrentProjectId(projectId: string | null): void {
  currentProjectId = projectId;
}

/** Current Project id for imperative application and feature services. */
export function getCurrentProjectId(): string {
  return currentProjectId ?? FALLBACK_PROJECT_ID;
}

/** Nullable identity for callers that must distinguish bootstrap from loaded. */
export function getLoadedProjectId(): string | null {
  return currentProjectId;
}
