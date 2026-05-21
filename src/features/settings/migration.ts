import * as api from "./api";
import { KEY_SCOPE } from "./types";
import { PROJECT_ID } from "@/features/project/constants";

const SCHEMA_VERSION_KEY = "meta.settingsSchemaVersion";
const CURRENT_VERSION = 1;

/**
 * Migrate app_settings (workspace-scoped DB) to the new split stores:
 * - Global-scope keys → GlobalSettings.userPreferences (global-settings.json)
 * - Project-scope keys → project_settings table (idempotent: skip if already present)
 *
 * Reads migration version from app_settings["meta.settingsSchemaVersion"].
 * Safe to call multiple times (idempotent after version bump).
 *
 * Must be called after the workspace DB is open AND GlobalSettings are loaded
 * into useWorkspaceStore, but before useSettingsStore.loadAll().
 */
export async function migrateAppSettingsToScopedStores(): Promise<void> {
  const versionStr = await api.getSetting(SCHEMA_VERSION_KEY);
  const version = versionStr ? parseInt(versionStr, 10) : 0;
  if (version >= CURRENT_VERSION) return;

  const all = await api.getSettingsByPrefix("");

  const globalUpdates: Record<string, string> = {};
  const projectUpdates: Record<string, string> = {};

  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("meta.")) continue;
    const scope = KEY_SCOPE[key];
    if (scope === "global") {
      globalUpdates[key] = value;
    } else if (scope === "project") {
      projectUpdates[key] = value;
    }
  }

  // Batch-write global preferences (last-open-wins for cross-workspace conflicts)
  if (Object.keys(globalUpdates).length > 0) {
    const { useWorkspaceStore } = await import("@/features/workspace/store");
    const ws = useWorkspaceStore.getState();
    const current = ws.globalSettings;
    if (current) {
      await ws.updateGlobalSettings({
        userPreferences: {
          ...(current.userPreferences ?? {}),
          ...globalUpdates,
        },
      });
    }
  }

  // Insert project settings idempotently (skip if already present)
  for (const [key, value] of Object.entries(projectUpdates)) {
    const existing = await api.getProjectSetting(PROJECT_ID, key);
    if (existing === null) {
      await api.setProjectSetting(PROJECT_ID, key, value);
    }
  }

  await api.setSetting(SCHEMA_VERSION_KEY, String(CURRENT_VERSION));
}

/**
 * Seed project_settings from globalSettings.projectDefaults.
 * Idempotent: skips keys already present in project_settings.
 * Must be called after the workspace DB is open. Used both for new workspaces
 * (default project) and for projects created later via the Project switcher.
 */
export async function seedProjectSettingsFromDefaults(
  projectId: string = PROJECT_ID,
): Promise<void> {
  const { useWorkspaceStore } = await import("@/features/workspace/store");
  const defaults =
    useWorkspaceStore.getState().globalSettings?.projectDefaults ?? {};
  for (const [key, value] of Object.entries(defaults)) {
    const existing = await api.getProjectSetting(projectId, key);
    if (existing === null) {
      await api.setProjectSetting(projectId, key, value);
    }
  }
}
