import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import { globalSettingsRepository } from "@/lib/globalSettings/repository";
import type { WorkspaceState } from "./store";

type WorkspaceStoreGetter = () => WorkspaceState;
type WorkspaceStoreSetter = (partial: Partial<WorkspaceState>) => void;

let initializeInFlight: Promise<void> | null = null;

async function runWorkspaceInitialization(
  get: WorkspaceStoreGetter,
  set: WorkspaceStoreSetter,
): Promise<void> {
  try {
    let settings = await globalSettingsRepository.read();
    set({ globalSettings: settings });

    if (
      settings.recentWorkspaces.length > 0 &&
      (!settings.trustedWorkspaces || settings.trustedWorkspaces.length === 0)
    ) {
      const trusted = settings.recentWorkspaces.map(
        (workspace) => workspace.path,
      );
      const migrated = { ...settings, trustedWorkspaces: trusted };
      await globalSettingsRepository.write(migrated);
      settings = migrated;
      set({ globalSettings: settings });
    }

    // Panel windows follow the main window's active Workspace and therefore
    // ignore the welcome/launcher preference.
    if (isPanelWindow() && settings.lastActiveWorkspace) {
      await get().openRecentWorkspace(
        settings.lastActiveWorkspace,
        "startup-auto",
      );
      showLauncherAfterSettledFailure(get, set);
      return;
    }

    if (settings.recentWorkspaces.length === 0) {
      set({ view: "welcome" });
      return;
    }
    if (settings.showLauncherOnStartup) {
      set({ view: "launcher" });
      return;
    }
    if (settings.lastActiveWorkspace) {
      await get().openRecentWorkspace(
        settings.lastActiveWorkspace,
        "startup-auto",
      );
      showLauncherAfterSettledFailure(get, set);
      return;
    }
    set({ view: "launcher" });
  } catch {
    set({ view: "welcome", globalSettings: null });
  }
}

function showLauncherAfterSettledFailure(
  get: WorkspaceStoreGetter,
  set: WorkspaceStoreSetter,
): void {
  const state = get();
  if (state.view === "loading" && !state.workspaceOpenRequestInProgress) {
    set({ view: "launcher" });
  }
}

/**
 * React StrictMode mounts the bootstrap effect twice in development. Keep the
 * startup operation singleflight so every caller joins the same result while
 * still allowing a later retry after either success or failure settles.
 */
export function initializeWorkspaceStore(
  get: WorkspaceStoreGetter,
  set: WorkspaceStoreSetter,
): Promise<void> {
  if (initializeInFlight) return initializeInFlight;

  const run = runWorkspaceInitialization(get, set);
  initializeInFlight = run;
  const clear = () => {
    if (initializeInFlight === run) initializeInFlight = null;
  };
  void run.then(clear, clear);
  return run;
}
