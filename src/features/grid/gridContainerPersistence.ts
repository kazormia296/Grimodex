import {
  getProjectSetting,
  setProjectSetting,
  deleteProjectSetting,
} from "@/features/settings/api";

const KEY = "grid.containerId";

/**
 * Persist the Grid panel's selected container (folder) ID per-project.
 * Falls back to null (= project root) when the ID is missing, stale, or invalid.
 */
export async function loadContainerId(
  projectId: string,
): Promise<string | null> {
  return getProjectSetting(projectId, KEY);
}

export async function saveContainerId(
  projectId: string,
  id: string,
): Promise<void> {
  await setProjectSetting(projectId, KEY, id);
}

export async function clearContainerId(projectId: string): Promise<void> {
  await deleteProjectSetting(projectId, KEY);
}
