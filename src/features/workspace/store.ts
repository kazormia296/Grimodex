import { create } from "zustand";
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

  initialize: () => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
  openRecentWorkspace: (path: string) => Promise<void>;
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

  initialize: async () => {
    try {
      const settings = await invoke<GlobalSettings>("get_global_settings");
      set({ globalSettings: settings });

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
          await get().openWorkspace(settings.lastActiveWorkspace);
          // Defensive: if openWorkspace failed internally, don't stay on loading
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
        error: `ワークスペース "${path}" は存在しないか無効です。一覧から削除しました。`,
      });
      return;
    }
    await get().openWorkspace(path);
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
