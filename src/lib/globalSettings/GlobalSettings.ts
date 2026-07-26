import type { ChronicleSettings } from "@/features/chronicle/chronicleStore";
import type { TimelineSettings } from "@/features/timeline/timelineStore";

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
  /** Last app version for which the user has seen release notes (e.g. "0.10.4"). */
  lastSeenReleaseNotesVersion?: string;
  /** Persisted timeline panel state */
  timeline?: TimelineSettings;
  /** Persisted chronicle (作中年表) panel state */
  chronicle?: ChronicleSettings;
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
