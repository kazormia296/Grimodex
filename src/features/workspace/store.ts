import { create } from "zustand";
import i18next from "@/lib/i18n";
import { invoke } from "@/lib/tauri";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { globalSettingsRepository } from "@/lib/globalSettings/repository";
import type { GlobalSettings } from "@/lib/globalSettings/GlobalSettings";
import {
  beginWorkspaceSwitch,
  endWorkspaceSwitch,
} from "@/features/timelapse/recorder";
import {
  ensureProjectActive,
  hydrateWorkspaceProject,
  initializeWorkspaceProject,
  invalidateWorkspaceProjectLoads,
} from "@/application/project/workspaceProjectCommands";
import { toast } from "sonner";
import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import {
  getCurrentImeWorkspaceIdentity,
  setCurrentImeWorkspaceIdentity,
} from "@/features/ime/workspaceScope";
import { flushStrictQuiescence } from "@/application/lifecycle/quiescenceCoordinator";
import {
  acquireQuiescenceLease,
  type QuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import { clearRetainedEditorRecoveryDraftsForScopeChange } from "@/features/editor/editorSaveRegistry";
import {
  acquireWorkspaceProjectLoadLease,
  type WorkspaceProjectLoadLease,
} from "@/features/project/projectLoadGate";
import { hydrateWorkspaceStores } from "@/application/workspace/workspaceHydration";
import { ensureRuntimeStoreComposition } from "@/application/composition/runtimeStoreCompositionLoader";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { cancelWorkspaceScopedSchedules } from "@/application/workspace/workspaceScheduleQuiescence";
import {
  beginWorkspaceOpenRequest,
  runWorkspaceOpenRequest,
  type WorkspaceOpenOutcome,
} from "./workspaceOpenRequest";

export type {
  GlobalSettings,
  RecentWorkspace,
} from "@/lib/globalSettings/GlobalSettings";

export type AppView = "loading" | "welcome" | "launcher" | "editor";

export type { WorkspaceOpenOutcome } from "./workspaceOpenRequest";

interface OpenWorkspaceResult {
  name: string;
  isExisting: boolean;
  /** Stable UUID from `.grimodex/workspace.json` (missing only on an old backend). */
  workspaceId?: string;
}

export interface WorkspaceState {
  view: AppView;
  globalSettings: GlobalSettings | null;
  activeWorkspacePath: string | null;
  /** Stable persisted Workspace identity; unlike openRevision, survives restarts. */
  activeWorkspaceId: string | null;
  /**
   * In-memory identity for the currently opened DB instance. Incremented on
   * every successful open, including a same-path reopen after sample reseed or
   * restore, where `activeWorkspacePath` alone cannot signal a new database.
   */
  workspaceOpenRevision: number;
  /** True from pre-open quiesce until all post-swap store hydration settles. */
  workspaceSwitchInProgress: boolean;
  /** True from the first path validation until that user request settles. */
  workspaceOpenRequestInProgress: boolean;
  /** True only after the active DB's project/settings hydration completed. */
  workspaceHydrated: boolean;
  activeWorkspaceName: string | null;
  error: string | null;
  pendingTrustPath: string | null;
  /** In-memory only — not persisted. True while SampleTour should be shown. */
  showSampleTour: boolean;

  initialize: () => Promise<void>;
  openWorkspace: (path: string) => Promise<WorkspaceOpenOutcome>;
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

// JS側でも多重openとquiesce／recorder suspendの重複を防ぐ。
let openWorkspaceInFlight = false;

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  view: "loading",
  globalSettings: null,
  activeWorkspacePath: null,
  activeWorkspaceId: null,
  workspaceOpenRevision: 0,
  workspaceSwitchInProgress: false,
  workspaceOpenRequestInProgress: false,
  workspaceHydrated: false,
  activeWorkspaceName: null,
  error: null,
  pendingTrustPath: null,
  showSampleTour: false,

  initialize: async () => {
    try {
      let settings = await globalSettingsRepository.read();
      set({ globalSettings: settings });

      // Migration: trust all existing recent workspaces for existing users
      if (
        settings.recentWorkspaces.length > 0 &&
        (!settings.trustedWorkspaces || settings.trustedWorkspaces.length === 0)
      ) {
        const trusted = settings.recentWorkspaces.map((ws) => ws.path);
        const migrated = { ...settings, trustedWorkspaces: trusted };
        await globalSettingsRepository.write(migrated);
        settings = migrated;
        set({ globalSettings: settings });
      }

      // フローティング パネル窓は main 窓と同じワークスペースに追従する。
      // welcome/launcher の好みは無視し、最後に開いていたワークスペース
      // （= main 窓が開いているもの）を直接開いて editor へ。
      if (isPanelWindow() && settings.lastActiveWorkspace) {
        await get().openRecentWorkspace(settings.lastActiveWorkspace);
        if (get().view === "loading") set({ view: "launcher" });
        return;
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
        await get().openRecentWorkspace(settings.lastActiveWorkspace);
        // Defensive: if opening failed internally, don't stay on loading.
        if (get().view === "loading") {
          set({ view: "launcher" });
        }
        return;
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
      return "in-progress";
    }
    if (guardInlineAiPending()) return "blocked";
    openWorkspaceInFlight = true;
    const previousWorkspaceHydrated = get().workspaceHydrated;
    const previousImeWorkspaceIdentity = getCurrentImeWorkspaceIdentity();
    const previousProjectId = getCurrentProjectId();
    let swapDone = false;
    let openResult: OpenWorkspaceResult | null = null;
    let targetOpenRevision: number | null = null;
    let targetSettings: GlobalSettings | null = null;
    let projectLoadLease: WorkspaceProjectLoadLease | null = null;
    let quiescenceLease: QuiescenceLease | null = null;
    try {
      quiescenceLease = acquireQuiescenceLease("workspace-open", {
        transition: {
          kind: "workspace",
          from: {
            workspacePath: get().activeWorkspacePath,
            workspaceOpenRevision: get().workspaceOpenRevision,
            projectId: previousProjectId,
          },
          to: {
            workspacePath: path,
            workspaceOpenRevision: null,
            projectId: null,
          },
        },
      });
      // Debounced snapshot writes carry the old Project id. Stop them before
      // any await so they cannot wake up against the replacement database.
      cancelWorkspaceScopedSchedules();
      set({
        error: null,
        workspaceSwitchInProgress: true,
        workspaceHydrated: false,
      });
      // Exclude new Project loads, invalidate every load bound to the old DB,
      // and await the complete load operation before quiescing/switching. The
      // lease remains held through initCurrentProject + identity publication.
      projectLoadLease = await acquireWorkspaceProjectLoadLease(
        invalidateWorkspaceProjectLoads,
      );
      // DB コマンドの async 化 (M3) で save と open_workspace が並行しうる。
      // swap を跨いだ in-flight write が旧 workspace の内容を新 workspace の
      // DB に落とさないよう、切替前に書き込みを静止させる:
      // (a) マウント中の全 AutoSave を flush、(b) pending scene write の完了
      // 待ち、(c) timelapse recorder の flush。1 件でも失敗した場合は例外を
      // outer catch へ伝え、native open_workspace より前に切替を中断する。
      // 旧 DB/UI binding と dirty editor はそのまま維持される。
      await flushStrictQuiescence(undefined, {
        transition: quiescenceLease.transition,
      });
      clearRetainedEditorRecoveryDraftsForScopeChange();
      // Existing Project lifecycles and every old-scope persistence surface
      // have now settled. Keep the old identity published until this point so
      // an interrupted create/update can complete or roll back against the
      // database it actually owns; only the native swap window is unbound.
      setCurrentImeWorkspaceIdentity(null);
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
      try {
        // Runtime benchmark origin: native workspace open starts here. The
        // consumer ends the interval only after a seeded scene is visible, so
        // this cannot accidentally regress to measuring bridge/header readiness.
        performance.mark("grimodex.workspaceOpen.start");
        const compositionReady = ensureRuntimeStoreComposition();
        void compositionReady.catch(() => undefined);
        openResult = await invoke<OpenWorkspaceResult>("open_workspace", {
          path,
        });
        swapDone = true;
        targetOpenRevision = get().workspaceOpenRevision + 1;
        await compositionReady;
      } finally {
        // swap 未実行の失敗 = 旧 workspace 続行なので旧束縛は依然正しい →
        // 復元して記録をそのまま再開する。swap 済みなら束縛は無効のまま =
        // 正規 rebind (initRecorderForProject) の完了だけが記録を再開する。
        endWorkspaceSwitch({ restoreBinding: !swapDone });
      }
      if (!openResult || targetOpenRevision === null) {
        throw new Error("Workspace swap completed without target identity");
      }
      const result = openResult;
      const nextOpenRevision = targetOpenRevision;
      // The native binding now points at the target Workspace and the old UI
      // remains semantically unavailable. Permit this controlled target
      // hydration phase; reads are sealed again before identity publication.
      quiescenceLease.openTargetReadPhase();
      // Resolve the current Project before the editor view renders so that
      // panels reading currentProjectId have a value to work with.
      const projectId = await initializeWorkspaceProject();
      // Re-read global settings after open_workspace updated them
      const settings = await globalSettingsRepository.read();
      targetSettings = settings;
      await hydrateWorkspaceStores({
        projectId,
        settings,
        isExisting: result.isExisting,
      });
      if (!projectLoadLease) {
        throw new Error("Workspace Project-load lease was released too early");
      }
      // Hydrate the replacement Project for every Workspace open while the
      // Workspace-owned gate still excludes user Project switches. This path
      // deliberately skips a second strict flush: the old UI was drained
      // before native open, and flushing it after the swap could write stale
      // content into the replacement database.
      await hydrateWorkspaceProject(
        projectId,
        projectLoadLease.projectLoadContext,
        nextOpenRevision,
      );
      quiescenceLease.transition?.updateTarget({
        workspaceOpenRevision: nextOpenRevision,
        projectId,
      });
      // Publish identity/ready only after Project critical snapshots and every
      // other mandatory Workspace surface have committed. The gate stays held
      // through this publication, so a queued Project load cannot supersede
      // the mandatory hydrate in between.
      quiescenceLease.sealReadsForAuthorityCommit();
      setCurrentImeWorkspaceIdentity({
        path,
        openRevision: nextOpenRevision,
      });
      set({
        view: "editor",
        activeWorkspacePath: path,
        // Keep an old native binding usable during a rolling development
        // upgrade. Current backends always return workspaceId.
        activeWorkspaceId: result.workspaceId ?? path,
        workspaceOpenRevision: nextOpenRevision,
        activeWorkspaceName: result.name,
        globalSettings: settings,
        workspaceHydrated: false,
      });
      quiescenceLease.transition?.advance("authority-commit");
      set({
        workspaceSwitchInProgress: false,
        workspaceHydrated: true,
      });
      quiescenceLease.transition?.advance("new-scope-hydrated");
      // Optimize FTS indexes in background (fire-and-forget)
      invoke("fts_optimize").catch(() => {});
      return "opened";
    } catch (e) {
      // open 失敗時も recorder への命令的な復帰はしない (r5)。束縛の扱いは
      // swap を括る endWorkspaceSwitch({restoreBinding}) が一元的に決めた。
      // swap 後の後続処理の失敗では束縛は無効のまま = 次の正規 rebind まで
      // イベントは warn 付きで破棄される (誤束縛での混入より安全側)。
      const error = e instanceof Error ? e.message : String(e);
      if (swapDone && openResult && targetOpenRevision !== null) {
        // Native authority has already changed. Publish the target session's
        // metadata even though hydration failed, so every renderer guard sees
        // a new DB generation instead of presenting the previous Workspace as
        // active. Identity remains null and hydration false until a retry.
        set({
          view: "launcher",
          activeWorkspacePath: path,
          activeWorkspaceId: openResult.workspaceId ?? path,
          workspaceOpenRevision: targetOpenRevision,
          activeWorkspaceName: openResult.name,
          ...(targetSettings ? { globalSettings: targetSettings } : {}),
          error,
          workspaceHydrated: false,
        });
      } else {
        // Native open rejected before swap: the previous DB/UI binding remains
        // valid, so restore its semantic-ready state.
        set({
          error,
          workspaceHydrated: previousWorkspaceHydrated,
          ...(get().view === "loading" ? { view: "launcher" as const } : {}),
        });
      }
      if (!swapDone && previousWorkspaceHydrated) {
        setCurrentImeWorkspaceIdentity(previousImeWorkspaceIdentity);
      }
      return "failed";
    } finally {
      projectLoadLease?.release();
      quiescenceLease?.release();
      if (get().workspaceSwitchInProgress) {
        set({ workspaceSwitchInProgress: false });
      }
      openWorkspaceInFlight = false;
    }
  },

  async requestOpenWorkspace(path: string) {
    await runWorkspaceOpenRequest({ path, recent: false }, get, set);
  },

  async trustAndOpen() {
    const path = get().pendingTrustPath;
    if (!path) return;
    const finish = beginWorkspaceOpenRequest(path, (inProgress) =>
      set({ workspaceOpenRequestInProgress: inProgress }),
    );
    if (!finish) return;
    try {
      const trusted = get().globalSettings?.trustedWorkspaces ?? [];
      const saved = await get().updateGlobalSettings({
        trustedWorkspaces: [...trusted, path],
      });
      if (!saved) return;
      set({ pendingTrustPath: null });
      await get().openWorkspace(path);
    } catch (error) {
      debugLog.error(
        "workspaceStore",
        "trusted workspace open failed",
        errorDetail(error),
      );
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      finish();
    }
  },

  cancelTrust() {
    set({ pendingTrustPath: null });
  },

  async openRecentWorkspace(path: string) {
    await runWorkspaceOpenRequest({ path, recent: true }, get, set);
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
      const saved = await globalSettingsRepository.patch((disk) => ({
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
      const saved = await globalSettingsRepository.patch((disk) => ({
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
      const saved = await globalSettingsRepository.patch((disk) => ({
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
      const openOutcome = await get().openWorkspace(result.path);
      if (openOutcome !== "opened") {
        throw new Error(`Tutorial workspace open ${openOutcome}`);
      }
      if (!(await ensureProjectActive(result.projectId))) {
        throw new Error("Tutorial project did not become active");
      }
      set({ showSampleTour: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      debugLog.error(
        "workspaceStore",
        "sample tutorial setup failed",
        errorDetail(e),
      );
      set({ error: message });
    }
  },
}));
