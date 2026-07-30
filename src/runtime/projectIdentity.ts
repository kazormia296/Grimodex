/** Renderer-local identity of the Project currently bound to this window. */
let currentProjectId: string | null = null;

export function setCurrentRuntimeProjectId(projectId: string): void {
  currentProjectId = projectId;
}

export function isCurrentRuntimeProjectId(projectId: string): boolean {
  return currentProjectId === projectId;
}
