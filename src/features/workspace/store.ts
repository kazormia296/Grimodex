import { create } from "zustand";
import i18next from "@/lib/i18n";
import { invoke } from "@/lib/tauri";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { loadAndSyncTimelineSettings } from "@/features/timeline/timelineStore";
import type { TimelineSettings } from "@/features/timeline/timelineStore";
import { useMapStore } from "@/features/map/mapStore";
import { useGridStore } from "@/features/grid/gridStore";
import { useProjectStore } from "@/features/project/projectStore";

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
  /** Region/slot layout v2 (PersistedLayout) */
  layout?: unknown;
  layoutVersion?: number;
  /** User-saved layout presets (LayoutState snapshots) */
  layoutPresets?: Array<{
    id: string;
    name: string;
    state: unknown;
    hiddenStripePanels?: string[];
  }>;
  /** User overrides for built-in layout presets (keyed by builtin:* id) */
  builtinLayoutPresetOverrides?: Record<
    string,
    { state: unknown; hiddenStripePanels?: string[] }
  >;
  /** ID of the last-applied layout preset */
  activeLayoutPresetId?: string | null;
  /** Per-panel tool window state (slot / view mode / undock size) */
  toolWindows?: Record<string, unknown>;
  /** Panel ids that have icons on the stripe (persist across close so icon doesn't disappear) */
  stripePanelIds?: string[];
  /** Stripe (left/right/bottom) widths in px */
  stripeSizes?: Record<string, number>;
  /** Stripe visibility per region */
  stripeVisibility?: Record<string, boolean>;
  /** Named color theme (e.g. "dark-academia"). Undefined = default theme. */
  colorTheme?: string;
  /** Workspace paths the user has explicitly trusted. */
  trustedWorkspaces?: string[];
  /** Whether the user has already seen the welcome tour. */
  hasSeenWelcome?: boolean;
  /** Version of the EULA the user has accepted. Mismatch with current version triggers modal. */
  acceptedEulaVersion?: string;
  /** Persisted timeline panel state */
  timeline?: TimelineSettings;
  /** Persisted map panel state */
  map?: unknown;
  /** Persisted grid panel display settings */
  grid?: unknown;
  /** Persisted matrix panel settings */
  matrix?: unknown;
  /**
   * User-preference settings (cross-workspace): editor visuals, keys, display, data, revision.
   * Keyed by the same key strings used in app_settings (e.g. "editor.fontFamily").
   */
  userPreferences?: Record<string, string>;
  /**
   * Default values applied to new projects on creation.
   * Covers work-specific settings (tree.*, export.*, beat.*, editor.targetCharCount, ai.contextBudget.*).
   */
  projectDefaults?: Record<string, string>;
  /** Default AI policy preset applied to new projects (JSON-serialized AiPolicy). */
  defaultAiPolicy?: string;
  /** Path to the sample workspace created during onboarding. Used for re-run flow. */
  sampleWorkspacePath?: string;
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
  /** In-memory only — not persisted. True while SampleTour should be shown. */
  showSampleTour: boolean;

  initialize: () => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
  requestOpenWorkspace: (path: string) => Promise<void>;
  openRecentWorkspace: (path: string) => Promise<void>;
  trustAndOpen: () => Promise<void>;
  cancelTrust: () => void;
  updateGlobalSettings: (updates: Partial<GlobalSettings>) => Promise<void>;
  updateUserPreference: (key: string, value: string) => Promise<void>;
  updateProjectDefaults: (updates: Record<string, string>) => Promise<void>;
  showLauncher: () => void;
  clearError: () => void;
  setShowSampleTour: (show: boolean) => void;
  /** Seed sample workspace, open it, and flag tour to show. */
  seedAndOpenSample: (language: string, aiPolicy: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  view: "loading",
  globalSettings: null,
  activeWorkspacePath: null,
  activeWorkspaceName: null,
  error: null,
  pendingTrustPath: null,
  showSampleTour: false,

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
      // Resolve the current Project before the editor view renders so that
      // panels reading currentProjectId have a value to work with.
      await useProjectStore.getState().initCurrentProject();
      // Re-read global settings after open_workspace updated them
      const settings = await invoke<GlobalSettings>("get_global_settings");
      set({
        view: "editor",
        activeWorkspacePath: path,
        activeWorkspaceName: result.name,
        globalSettings: settings,
      });
      // Migrate app_settings → userPreferences + project_settings (runs once per workspace)
      const {
        migrateAppSettingsToScopedStores,
        seedProjectSettingsFromDefaults,
      } = await import("@/features/settings/migration");
      await migrateAppSettingsToScopedStores();
      // Seed project defaults for brand-new workspaces
      if (!result.isExisting) {
        await seedProjectSettingsFromDefaults();
      }
      // Load persisted editor settings and apply to runtime stores
      await useSettingsStore.getState().loadAll();
      useCursorSettingsStore.getState().initFromSettings();
      // Lint config depends on settings being loaded first.
      const { useLintConfigStore } =
        await import("@/features/lint/lintConfigStore");
      useLintConfigStore.getState().load();
      if (settings.timeline) {
        loadAndSyncTimelineSettings(settings.timeline);
      }
      useMapStore.getState().loadFromSettings(settings);
      useGridStore.getState().loadFromSettings(settings);
      const { useMatrixStore } = await import("@/features/matrix/matrixStore");
      useMatrixStore.getState().loadFromSettings(settings);
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
      // New workspace — open first (creates DB, updates recentWorkspaces)
      await get().openWorkspace(path);
      // Add to trusted list so next launch skips the trust dialog
      const currentTrusted = get().globalSettings?.trustedWorkspaces ?? [];
      if (!currentTrusted.includes(path)) {
        await get().updateGlobalSettings({
          trustedWorkspaces: [...currentTrusted, path],
        });
      }
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

  async updateUserPreference(key: string, value: string) {
    const current = get().globalSettings;
    if (!current) return;
    const updated = {
      ...current,
      userPreferences: { ...(current.userPreferences ?? {}), [key]: value },
    };
    set({ globalSettings: updated });
    try {
      await invoke("save_global_settings", { settings: updated });
    } catch {
      set({ globalSettings: current });
    }
  },

  async updateProjectDefaults(updates: Record<string, string>) {
    const current = get().globalSettings;
    if (!current) return;
    const updated = {
      ...current,
      projectDefaults: { ...(current.projectDefaults ?? {}), ...updates },
    };
    set({ globalSettings: updated });
    try {
      await invoke("save_global_settings", { settings: updated });
    } catch {
      set({ globalSettings: current });
    }
  },

  showLauncher: () => {
    set({ view: "launcher" });
  },

  clearError: () => {
    set({ error: null });
  },

  setShowSampleTour: (show: boolean) => {
    set({ showSampleTour: show });
  },

  async seedAndOpenSample(language: string, aiPolicy: string) {
    try {
      set({ error: null });
      const result = await invoke<{ path: string; projectId: string }>(
        "seed_sample_workspace",
        { language, aiPolicy },
      );
      // Add to trusted workspaces so the trust dialog is bypassed
      const currentTrusted = get().globalSettings?.trustedWorkspaces ?? [];
      if (!currentTrusted.includes(result.path)) {
        await get().updateGlobalSettings({
          trustedWorkspaces: [...currentTrusted, result.path],
        });
      }
      await get().openWorkspace(result.path);
      set({ showSampleTour: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
