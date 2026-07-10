import { useSettingsStore } from "@/features/settings/settingsStore";
import { invoke } from "@/lib/tauri";

export type ImeIntegrationMode = "auto" | "on" | "off";

export interface ImeExportOptions {
  mode: ImeIntegrationMode;
  excludeHidden: boolean;
  includeProfile: boolean;
}

export interface ImeConsumerInfo {
  consumerId: string;
  name: string;
  version: string;
  lastSeen: string;
  capabilities: Record<string, boolean>;
}

export interface ImeExportStatus {
  rootPath: string;
  consumers: ImeConsumerInfo[];
  activeProjectId: string | null;
  exportedProjectCount: number;
  effectiveEnabled: boolean;
}

function currentMode(): ImeIntegrationMode {
  const value = useSettingsStore.getState().get("ime.integrationMode", "auto");
  return value === "on" || value === "off" ? value : "auto";
}

function currentOptions(): ImeExportOptions {
  const settings = useSettingsStore.getState();
  return {
    mode: currentMode(),
    excludeHidden: settings.getBoolean("ime.excludeHidden", false),
    includeProfile: settings.getBoolean("ime.includeProfile", true),
  };
}

export function refreshImeExport(projectId: string): Promise<ImeExportStatus> {
  return invoke<ImeExportStatus>("ime_export_refresh", {
    projectId,
    options: currentOptions(),
  });
}

export function setActiveImeProject(
  projectId: string | null,
): Promise<ImeExportStatus> {
  return invoke<ImeExportStatus>("ime_export_set_active_project", {
    projectId,
    mode: currentMode(),
  });
}

export function getImeExportStatus(): Promise<ImeExportStatus> {
  return invoke<ImeExportStatus>("ime_export_get_status", {
    mode: currentMode(),
  });
}

export function clearImeExports(): Promise<void> {
  return invoke<void>("ime_export_clear_all");
}

export function removeImeProjectExport(projectId: string): Promise<void> {
  return invoke<void>("ime_export_remove_project", { projectId });
}

const REMOVE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

function scheduleRemoveRetry(projectId: string, attempt: number): void {
  const delay = REMOVE_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    console.error(
      `[ime] snapshot cleanup permanently failed for deleted project ${projectId}`,
    );
    return;
  }
  setTimeout(() => {
    void removeImeProjectExport(projectId).catch((error) => {
      console.warn(
        `[ime] snapshot cleanup retry ${attempt + 1} failed for ${projectId}`,
        error,
      );
      scheduleRemoveRetry(projectId, attempt + 1);
    });
  }, delay);
}

/**
 * A deleted DB row cannot trigger a later refresh, so cleanup failures need
 * their own bounded retry path instead of being silently forgotten.
 */
export async function removeImeProjectExportWithRetry(
  projectId: string,
): Promise<void> {
  try {
    await removeImeProjectExport(projectId);
  } catch (error) {
    console.warn(
      `[ime] snapshot cleanup failed for deleted project ${projectId}; retrying`,
      error,
    );
    scheduleRemoveRetry(projectId, 0);
  }
}
