import { create } from "zustand";
import i18next from "@/lib/i18n";
import { invoke } from "@/lib/tauri";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { patchGlobalSettings } from "@/lib/globalSettings";
import { flushAllAutoSaves } from "@/hooks/useAutoSave";
import { awaitAllPendingSceneWrites } from "@/features/tree/pendingSceneWrites";
import {
  flushNow as flushTimelapseRecorder,
  beginWorkspaceSwitch,
  endWorkspaceSwitch,
} from "@/features/timelapse/recorder";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { loadAndSyncTimelineSettings } from "@/features/timeline/timelineStore";
import type { TimelineSettings } from "@/features/timeline/timelineStore";
import { loadAndSyncChronicleSettings } from "@/features/chronicle/chronicleStore";
import type { ChronicleSettings } from "@/features/chronicle/chronicleStore";
import { useMapStore } from "@/features/map/mapStore";
import { useGridStore } from "@/features/grid/gridStore";
import {
  useProjectStore,
  getCurrentProjectId,
} from "@/features/project/projectStore";
import { toast } from "sonner";
import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import { cancelScheduledImeExports } from "@/features/ime/scheduler";
import {
  getCurrentImeWorkspaceIdentity,
  setCurrentImeWorkspaceIdentity,
} from "@/features/ime/workspaceScope";

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

export type AppView = "loading" | "welcome" | "launcher" | "editor";

interface OpenWorkspaceResult {
  name: string;
  isExisting: boolean;
}

interface WorkspaceState {
  view: AppView;
  globalSettings: GlobalSettings | null;
  activeWorkspacePath: string | null;
  /**
   * In-memory identity for the currently opened DB instance. Incremented on
   * every successful open, including a same-path reopen after sample reseed or
   * restore, where `activeWorkspacePath` alone cannot signal a new database.
   */
  workspaceOpenRevision: number;
  /** True from pre-open quiesce until all post-swap store hydration settles. */
  workspaceSwitchInProgress: boolean;
  /** True only after the active DB's project/settings hydration completed. */
  workspaceHydrated: boolean;
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
  // 保存成否を返す（true=永続化成功 / false=失敗してリバート済み）。fire-and-forget
  // 呼び出し側は戻り値を無視でき、保存失敗をユーザーへ通知したい呼び出し側は false を見る。
  updateGlobalSettings: (updates: Partial<GlobalSettings>) => Promise<boolean>;
  updateUserPreference: (key: string, value: string) => Promise<boolean>;
  updateProjectDefaults: (updates: Record<string, string>) => Promise<boolean>;
  showLauncher: () => void;
  clearError: () => void;
  setShowSampleTour: (show: boolean) => void;
  /** Seed sample workspace, open it, and flag tour to show. */
  seedAndOpenSample: (language: string, aiPolicy: string) => Promise<void>;
}

/**
 * openWorkspace の JS 側 in-flight ガード。連打で open_workspace が Rust の
 * open_lock 待ちに積まれるのと、quiesce / recorder suspend の多重実行を防ぐ。
 */
let openWorkspaceInFlight = false;

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  view: "loading",
  globalSettings: null,
  activeWorkspacePath: null,
  workspaceOpenRevision: 0,
  workspaceSwitchInProgress: false,
  workspaceHydrated: false,
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

      // フローティング パネル窓は main 窓と同じワークスペースに追従する。
      // welcome/launcher の好みは無視し、最後に開いていたワークスペース
      // （= main 窓が開いているもの）を直接開いて editor へ。
      if (isPanelWindow() && settings.lastActiveWorkspace) {
        const valid = await invoke<boolean>("validate_workspace_path", {
          path: settings.lastActiveWorkspace,
        });
        if (valid) {
          await get().requestOpenWorkspace(settings.lastActiveWorkspace);
          if (get().view === "loading") set({ view: "launcher" });
          return;
        }
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
    // 連打・多重呼び出しの in-flight ガード (Rust 側は open_lock で直列化
    // されるが、JS 側でも二重 open のキュー積みと quiesce の多重実行を防ぐ)。
    if (openWorkspaceInFlight) {
      debugLog.warn(
        "workspaceStore",
        "open_workspace already in flight; ignoring re-entry",
        path,
      );
      toast.info(i18next.t("workspace.openInProgress"));
      return;
    }
    openWorkspaceInFlight = true;
    // R4-1 系列A 検出用: 「エディタ表示中の同一パス再オープン」は
    // EditorScreen の key (activeWorkspacePath) が変わらず remount しない。
    const wasSamePathReopen =
      get().view === "editor" && get().activeWorkspacePath === path;
    const previousWorkspaceHydrated = get().workspaceHydrated;
    const previousImeWorkspaceIdentity = getCurrentImeWorkspaceIdentity();
    let swapDone = false;
    try {
      // Debounced snapshot writes carry the old Project id. Stop them before
      // any await so they cannot wake up against the replacement database.
      cancelScheduledImeExports();
      setCurrentImeWorkspaceIdentity(null);
      set({
        error: null,
        workspaceSwitchInProgress: true,
        workspaceHydrated: false,
      });
      // DB コマンドの async 化 (M3) で save と open_workspace が並行しうる。
      // swap を跨いだ in-flight write が旧 workspace の内容を新 workspace の
      // DB に落とさないよう、切替前に書き込みを静止させる:
      // (a) マウント中の全 AutoSave を flush、(b) pending scene write の完了
      // 待ち、(c) timelapse recorder の flush。ここで save が失敗しても既存の
      // 失敗 toast + dirty 維持 (リトライ) に任せ、切替自体は続行する
      // (Rust 側の switching ガードが最後の砦)。
      try {
        await flushAllAutoSaves();
        await awaitAllPendingSceneWrites();
        await flushTimelapseRecorder();
      } catch (e) {
        debugLog.warn(
          "workspaceStore",
          "pre-switch quiesce failed; proceeding with switch",
          errorDetail(e),
        );
      }
      // 切替開始 (r5 状態機械): recorder のキュー破棄 + 束縛無効化。切替中の
      // flush 再試行が open 完了後に新 workspace の hash chain へ旧イベントを
      // 混入させるのを防ぐ (C1)。記録の再開は「命令」ではなく、正規 rebind
      // (projectStore の initRecorderForProject) の完了だけが束縛を有効に戻す。
      //
      // begin〜end は swap (open_workspace invoke) だけを正確に括る。end を
      // openWorkspace 全体の finally に置くと、set({view}) 以降の await 中に
      // React が EditorScreen を mount して走らせた正規 rebind
      // (loadProject → initRecorderForProject) が switchInProgress=true の
      // bystander と誤判定され、束縛が二度と書かれない (= 記録の恒久停止)。
      // swap の成否が確定した時点で切替は終わり、以降の記録可否は
      // bindingInvalidated (rebind 完了まで true) が閉じる。
      // 既知残余 (理論値): end 後〜正規 rebind 前に完了した別経路の init は
      // 束縛を書けるが、その init は swap 済みの新 DB から tail を読むため
      // 「旧 workspace の束縛で新 chain に書く」誤束縛にはならない。
      beginWorkspaceSwitch();
      let result: OpenWorkspaceResult;
      try {
        result = await invoke<OpenWorkspaceResult>("open_workspace", {
          path,
        });
        // swap 完了。Rust 側 open_workspace は swap 以降 infallible
        // (src-tauri/src/commands/workspace.rs の不変条件コメント参照) なので
        // 「invoke エラー ⟹ swap 未実行」が成立し、下の restoreBinding 判定が
        // 安全になる。
        swapDone = true;
      } finally {
        // swap 未実行の失敗 = 旧 workspace 続行なので旧束縛は依然正しい →
        // 復元して記録をそのまま再開する。swap 済みなら束縛は無効のまま =
        // 正規 rebind (initRecorderForProject) の完了だけが記録を再開する。
        endWorkspaceSwitch({ restoreBinding: !swapDone });
      }
      // Resolve the current Project before the editor view renders so that
      // panels reading currentProjectId have a value to work with.
      await useProjectStore.getState().initCurrentProject();
      // Re-read global settings after open_workspace updated them
      const settings = await invoke<GlobalSettings>("get_global_settings");
      // Publish path + DB revision only after currentProjectId is rebound. The
      // editor is keyed by activeWorkspacePath, so exposing the new path before
      // initCurrentProject would mount the new DB with the old project's state.
      set((state) => ({
        view: "editor",
        activeWorkspacePath: path,
        workspaceOpenRevision: state.workspaceOpenRevision + 1,
        activeWorkspaceName: result.name,
        globalSettings: settings,
        workspaceSwitchInProgress: false,
        workspaceHydrated: true,
      }));
      setCurrentImeWorkspaceIdentity({
        path,
        openRevision: get().workspaceOpenRevision,
      });
      // Migrate app_settings → userPreferences + project_settings (runs once per workspace)
      const {
        migrateAppSettingsToScopedStores,
        migrateCardLayoutKey,
        migrateModelRoleKeys,
        resolveCardLayoutGlassConflict,
        seedProjectSettingsFromDefaults,
      } = await import("@/features/settings/migration");
      await migrateAppSettingsToScopedStores();
      await migrateCardLayoutKey();
      await migrateModelRoleKeys();
      await resolveCardLayoutGlassConflict();
      // Seed project defaults for brand-new workspaces
      if (!result.isExisting) {
        await seedProjectSettingsFromDefaults();
      }
      // Load persisted editor settings and apply to runtime stores
      await useSettingsStore.getState().loadAll();
      useCursorSettingsStore.getState().initFromSettings();
      {
        const { useCodexHighlightStore } =
          await import("@/features/editor/codexHighlightStore");
        useCodexHighlightStore.getState().initFromSettings();
        // 本文レイヤーの表示トグル (帰属 / 校閲) も設定から復元する
        const { useAttributionStore } =
          await import("@/features/attribution/attributionStore");
        useAttributionStore.getState().initFromSettings();
        const { useAnnotationStore } =
          await import("@/features/post-effect/annotationStore");
        useAnnotationStore.getState().initFromSettings();
      }
      // Lint config depends on settings being loaded first.
      const { useLintConfigStore } =
        await import("@/features/lint/lintConfigStore");
      useLintConfigStore.getState().load();
      if (settings.timeline) {
        loadAndSyncTimelineSettings(settings.timeline);
      }
      if (settings.chronicle) {
        loadAndSyncChronicleSettings(settings.chronicle);
      }
      useMapStore.getState().loadFromSettings(settings);
      useGridStore.getState().loadFromSettings(settings);
      const { useMatrixStore } = await import("@/features/matrix/matrixStore");
      useMatrixStore.getState().loadFromSettings(settings);
      // R4-1 系列A: 同一パスの再オープン (例: チュートリアル再実行 = seed で
      // DB を作り直して同じ path を open) では EditorScreen が remount せず、
      // mount 時の loadProject (正規 rebind の唯一の経路) が走らない。ここで
      // 明示的に再ロードする。loadProject は再実行安全: generation ガードが
      // 外部フィードの多重購読を防ぎ、reloadProjectData が in-memory 状態を
      // 作り直す。切替は上で終了済みなので、この rebind は bystander 扱い
      // されず束縛を書ける。
      if (wasSamePathReopen) {
        await useProjectStore.getState().loadProject(getCurrentProjectId());
      }
      // Optimize FTS indexes in background (fire-and-forget)
      invoke("fts_optimize").catch(() => {});
    } catch (e) {
      // open 失敗時も recorder への命令的な復帰はしない (r5)。束縛の扱いは
      // swap を括る endWorkspaceSwitch({restoreBinding}) が一元的に決めた。
      // swap 後の後続処理の失敗では束縛は無効のまま = 次の正規 rebind まで
      // イベントは warn 付きで破棄される (誤束縛での混入より安全側)。
      set({
        error: e instanceof Error ? e.message : String(e),
        // Native open rejected before swap: the previous DB/UI binding remains
        // valid, so restore its semantic-ready state. A post-swap hydration
        // failure must stay false to avoid issuing commands through stale UI.
        ...(!swapDone ? { workspaceHydrated: previousWorkspaceHydrated } : {}),
        // If still on loading screen (called from initialize), recover to launcher
        ...(get().view === "loading" ? { view: "launcher" as const } : {}),
      });
      if (!swapDone && previousWorkspaceHydrated) {
        setCurrentImeWorkspaceIdentity(previousImeWorkspaceIdentity);
      }
    } finally {
      if (get().workspaceSwitchInProgress) {
        set({ workspaceSwitchInProgress: false });
      }
      openWorkspaceInFlight = false;
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
    if (!current) return false;
    // 楽観更新（即時 UI 反映）。確定値は patch 解決後に上書きする。
    set({ globalSettings: { ...current, ...updates } });
    try {
      // ディスクの最新値へマージして保存する。layout/map/grid 等、所有 store が
      // セッション中に直接ディスクへ書いた slice を、開いた時点の stale な
      // in-memory スナップショットで潰さないため（旧実装のリグレッション）。
      const saved = await patchGlobalSettings((disk) => ({
        ...disk,
        ...updates,
      }));
      set({ globalSettings: saved });
      return true;
    } catch (e) {
      // Revert on failure
      set({ globalSettings: current });
      debugLog.error(
        "workspaceStore",
        "save_global_settings failed",
        errorDetail(e),
      );
      return false;
    }
  },

  async updateUserPreference(key: string, value: string) {
    const current = get().globalSettings;
    if (!current) return false;
    set({
      globalSettings: {
        ...current,
        userPreferences: { ...(current.userPreferences ?? {}), [key]: value },
      },
    });
    try {
      const saved = await patchGlobalSettings((disk) => ({
        ...disk,
        userPreferences: { ...(disk.userPreferences ?? {}), [key]: value },
      }));
      set({ globalSettings: saved });
      return true;
    } catch (e) {
      set({ globalSettings: current });
      debugLog.error(
        "workspaceStore",
        "save_global_settings (userPreference) failed",
        errorDetail(e),
      );
      return false;
    }
  },

  async updateProjectDefaults(updates: Record<string, string>) {
    const current = get().globalSettings;
    if (!current) return false;
    set({
      globalSettings: {
        ...current,
        projectDefaults: { ...(current.projectDefaults ?? {}), ...updates },
      },
    });
    try {
      const saved = await patchGlobalSettings((disk) => ({
        ...disk,
        projectDefaults: { ...(disk.projectDefaults ?? {}), ...updates },
      }));
      set({ globalSettings: saved });
      return true;
    } catch (e) {
      set({ globalSettings: current });
      debugLog.error(
        "workspaceStore",
        "save_global_settings (projectDefaults) failed",
        errorDetail(e),
      );
      return false;
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
      const previousSamplePath = get().globalSettings?.sampleWorkspacePath;
      const result = await invoke<{ path: string; projectId: string }>(
        "seed_sample_workspace",
        { language, aiPolicy },
      );
      // Each restart publishes a new immutable sample generation so a live DB
      // or external MCP reader is never unlinked. Replace the previous sample's
      // trust entry instead of accumulating one entry per tutorial restart.
      const currentTrusted = get().globalSettings?.trustedWorkspaces ?? [];
      const nextTrusted = currentTrusted.filter(
        (path) => path !== previousSamplePath && path !== result.path,
      );
      nextTrusted.push(result.path);
      if (
        nextTrusted.length !== currentTrusted.length ||
        nextTrusted.some((path, index) => path !== currentTrusted[index])
      ) {
        await get().updateGlobalSettings({
          trustedWorkspaces: nextTrusted,
        });
      }
      await get().openWorkspace(result.path);
      set({ showSampleTour: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
