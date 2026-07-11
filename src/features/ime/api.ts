import { useSettingsStore } from "@/features/settings/settingsStore";
import { invoke } from "@/lib/tauri";
import {
  getCurrentImeWorkspaceIdentity,
  isCurrentImeWorkspaceIdentity,
  type ImeWorkspaceIdentity,
} from "./workspaceScope";

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

function requireWorkspaceIdentity(
  identity?: ImeWorkspaceIdentity,
): ImeWorkspaceIdentity {
  const resolved = identity ?? getCurrentImeWorkspaceIdentity();
  if (!resolved || !isCurrentImeWorkspaceIdentity(resolved)) {
    throw new Error("IME workspace changed before the request started");
  }
  return resolved;
}

function assertWorkspaceIdentity(identity: ImeWorkspaceIdentity): void {
  if (!isCurrentImeWorkspaceIdentity(identity)) {
    throw new Error("IME workspace changed while the request was running");
  }
}

function requireRemovalWorkspaceIdentity(
  identity?: ImeWorkspaceIdentity,
): ImeWorkspaceIdentity {
  const resolved = identity ?? getCurrentImeWorkspaceIdentity();
  const current = getCurrentImeWorkspaceIdentity();
  if (!resolved || !current || current.path !== resolved.path) {
    throw new Error("IME workspace changed before snapshot cleanup started");
  }
  return resolved;
}

export async function refreshImeExport(
  projectId: string,
  identity?: ImeWorkspaceIdentity,
): Promise<ImeExportStatus> {
  const workspaceIdentity = requireWorkspaceIdentity(identity);
  const status = await invoke<ImeExportStatus>("ime_export_refresh", {
    projectId,
    expectedWorkspacePath: workspaceIdentity.path,
    options: currentOptions(),
  });
  assertWorkspaceIdentity(workspaceIdentity);
  return status;
}

export async function setActiveImeProject(
  projectId: string | null,
  identity?: ImeWorkspaceIdentity,
): Promise<ImeExportStatus> {
  const workspaceIdentity =
    projectId === null ? null : requireWorkspaceIdentity(identity);
  const status = await invoke<ImeExportStatus>(
    "ime_export_set_active_project",
    {
      projectId,
      expectedWorkspacePath: workspaceIdentity?.path ?? null,
      mode: currentMode(),
    },
  );
  if (workspaceIdentity) assertWorkspaceIdentity(workspaceIdentity);
  return status;
}

export function getImeExportStatus(): Promise<ImeExportStatus> {
  return invoke<ImeExportStatus>("ime_export_get_status", {
    mode: currentMode(),
  });
}

export function clearImeExports(): Promise<void> {
  return invoke<void>("ime_export_clear_all");
}

export async function removeImeProjectExport(
  projectId: string,
  identity?: ImeWorkspaceIdentity,
): Promise<void> {
  const workspaceIdentity = requireRemovalWorkspaceIdentity(identity);
  await invoke<void>("ime_export_remove_project", {
    projectId,
    expectedWorkspacePath: workspaceIdentity.path,
  });
  const current = getCurrentImeWorkspaceIdentity();
  if (current && current.path !== workspaceIdentity.path) {
    throw new Error("IME workspace changed while snapshot cleanup was running");
  }
}

const REMOVE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const REMOVE_SCOPE_WAIT_MS = 1_000;
const MAX_REMOVE_SCOPE_WAITS = 300;

function scheduleRemoveRetry(
  projectId: string,
  identity: ImeWorkspaceIdentity,
  attempt: number,
  scopeWaits = 0,
): void {
  const delay =
    scopeWaits > 0 ? REMOVE_SCOPE_WAIT_MS : REMOVE_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    console.error(
      `[ime] snapshot cleanup permanently failed for deleted project ${projectId}`,
    );
    return;
  }
  setTimeout(() => {
    // A retry belongs to the database where the deletion happened. In
    // particular, never remove an identically named Project in a replacement
    // workspace.
    const currentIdentity = getCurrentImeWorkspaceIdentity();
    if (!currentIdentity) {
      // `openWorkspace` temporarily clears the scope before the native swap.
      // A pre-swap failure restores it, so defer this attempt without
      // consuming the bounded retry budget.
      if (scopeWaits >= MAX_REMOVE_SCOPE_WAITS) {
        console.error(
          `[ime] snapshot cleanup abandoned after workspace scope did not settle for ${projectId}`,
        );
        return;
      }
      scheduleRemoveRetry(projectId, identity, attempt, scopeWaits + 1);
      return;
    }
    if (currentIdentity.path !== identity.path) return;
    void removeImeProjectExport(projectId, identity).catch((error) => {
      console.warn(
        `[ime] snapshot cleanup retry ${attempt + 1} failed for ${projectId}`,
        error,
      );
      scheduleRemoveRetry(projectId, identity, attempt + 1);
    });
  }, delay);
}

/**
 * A deleted DB row cannot trigger a later refresh, so cleanup failures need
 * their own bounded retry path instead of being silently forgotten.
 */
export async function removeImeProjectExportWithRetry(
  projectId: string,
  capturedIdentity?: ImeWorkspaceIdentity | null,
): Promise<void> {
  const identity =
    capturedIdentity === undefined
      ? getCurrentImeWorkspaceIdentity()
      : capturedIdentity;
  if (!identity) return;
  try {
    await removeImeProjectExport(projectId, identity);
  } catch (error) {
    console.warn(
      `[ime] snapshot cleanup failed for deleted project ${projectId}; retrying`,
      error,
    );
    scheduleRemoveRetry(projectId, identity, 0);
  }
}
