import { create } from "zustand";
import i18next from "@/lib/i18n";
import { invoke } from "@/lib/tauri";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";

export interface RecentWorkspace {
  path: string;
  lastOpened: string;
}

export interface GlobalSettings {
  recentWorkspaces: RecentWorkspace[];
  lastActiveWorkspace: string | null;
  theme: string;
  uiLanguage: string;
  uiScale: number;
  showLauncherOnStartup: boolean;
  /** Dockview layout serialization (project-independent UI state) */
  layout?: unknown;
  /** User-saved layout presets */
  layoutPresets?: Array<{ id: string; name: string; layout: unknown }>;
  /** ID of the last-applied layout preset */
  activeLayoutPresetId?: string | null;
  /** Named color theme (e.g. "dark-academia"). Undefined = default theme. */
  colorTheme?: string;
  /** Workspace paths the user has explicitly trusted. */
  trustedWorkspaces?: string[];
}

export type AppView = "loading" | "welcome" | "launcher" | "editor";

interface OpenWorkspaceResult {
  name: string;
  isExisting: boolean;
}

interface WorkspaceState {
  view: AppView;
  globalSettings: GlobalSettings | null;
  activeWorkspacePath: string | null;
  activeWorkspaceName: string | null;
  error: string | null;
  pendingTrustPath: string | null;

  initialize: () => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
  requestOpenWorkspace: (path: string) => Promise<void>;
  openRecentWorkspace: (path: string) => Promise<void>;
  trustAndOpen: () => Promise<void>;
  cancelTrust: () => void;
  updateGlobalSettings: (updates: Partial<GlobalSettings>) => Promise<void>;
  showLauncher: () => void;
  clearError: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  view: "loading",
  globalSettings: null,
  activeWorkspacePath: null,
  activeWorkspaceName: null,
  error: null,
  pendingTrustPath: null,

  initialize: async () => {
    try {
      let settings = await invoke<GlobalSettings>("get_global_settings");
      set({ globalSettings: settings });

      // Migration: trust all existing recent workspaces for existing users
      if (
        settings.recentWorkspaces.length > 0 &&
        (!settings.trustedWorkspaces || settings.trustedWorkspaces.length === 0)
      ) {
        const trusted = settings.recentWorkspaces.map((ws) => ws.path);
        const migrated = { ...settings, trustedWorkspaces: trusted };
        await invoke("save_global_settings", { settings: migrated });
        settings = migrated;
        set({ globalSettings: migrated });
      }

      // No workspaces at all → welcome screen
      if (settings.recentWorkspaces.length === 0) {
        set({ view: "welcome" });
        return;
      }

      // User prefers launcher on startup
      if (settings.showLauncherOnStartup) {
        set({ view: "launcher" });
        return;
      }

      // Try to open last active workspace
      if (settings.lastActiveWorkspace) {
        const valid = await invoke<boolean>("validate_workspace_path", {
          path: settings.lastActiveWorkspace,
        });
        if (valid) {
          await get().requestOpenWorkspace(settings.lastActiveWorkspace);
          // Defensive: if requestOpenWorkspace failed internally, don't stay on loading
          if (get().view === "loading") {
            set({ view: "launcher" });
          }
          return;
        }
      }

      // Last workspace invalid → launcher
      set({ view: "launcher" });
    } catch {
      // On any error, show welcome (fresh start)
      set({ view: "welcome", globalSettings: null });
    }
  },

  openWorkspace: async (path: string) => {
    try {
      set({ error: null });
      const result = await invoke<OpenWorkspaceResult>("open_workspace", {
        path,
      });
      // Re-read global settings after open_workspace updated them
      const settings = await invoke<GlobalSettings>("get_global_settings");
      set({
        view: "editor",
        activeWorkspacePath: path,
        activeWorkspaceName: result.name,
        globalSettings: settings,
      });
      // Load persisted editor settings and apply to runtime stores
      await useSettingsStore.getState().loadAll();
      useCursorSettingsStore.getState().initFromSettings();
      // Optimize FTS indexes in background (fire-and-forget)
      invoke("fts_optimize").catch(() => {});
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
        // If still on loading screen (called from initialize), recover to launcher
        ...(get().view === "loading" ? { view: "launcher" as const } : {}),
      });
    }
  },

  async requestOpenWorkspace(path: string) {
    const isExisting = await invoke<boolean>("validate_workspace_path", {
      path,
    });
    if (!isExisting) {
      // New workspace — auto-trust and open
      await get().openWorkspace(path);
      return;
    }
    // Existing workspace — check trust list
    const settings = get().globalSettings;
    const trusted = settings?.trustedWorkspaces ?? [];
    if (trusted.includes(path)) {
      await get().openWorkspace(path);
    } else {
      set({ pendingTrustPath: path });
    }
  },

  async trustAndOpen() {
    const path = get().pendingTrustPath;
    if (!path) return;
    const settings = get().globalSettings;
    const trusted = settings?.trustedWorkspaces ?? [];
    await get().updateGlobalSettings({
      trustedWorkspaces: [...trusted, path],
    });
    set({ pendingTrustPath: null });
    await get().openWorkspace(path);
  },

  cancelTrust() {
    set({ pendingTrustPath: null });
  },

  async openRecentWorkspace(path: string) {
    const isValid = await invoke<boolean>("validate_workspace_path", { path });
    if (!isValid) {
      const current = get().globalSettings;
      if (current) {
        await get().updateGlobalSettings({
          recentWorkspaces: current.recentWorkspaces.filter(
            (ws) => ws.path !== path,
          ),
        });
      }
      set({
        error: i18next.t("workspace.invalidPath", { path }),
      });
      return;
    }
    await get().requestOpenWorkspace(path);
  },

  async updateGlobalSettings(updates: Partial<GlobalSettings>) {
    const current = get().globalSettings;
    if (!current) return;
    const updated = { ...current, ...updates };
    set({ globalSettings: updated });
    try {
      await invoke("save_global_settings", { settings: updated });
    } catch {
      // Revert on failure
      set({ globalSettings: current });
    }
  },

  showLauncher: () => {
    set({ view: "launcher" });
  },

  clearError: () => {
    set({ error: null });
  },
}));
