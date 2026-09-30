import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { globalSettingsRepository } from "@/lib/globalSettings/repository";
import type { GlobalSettings } from "@/lib/globalSettings/GlobalSettings";
import { ensureProjectActive } from "@/application/project/workspaceProjectCommands";
import {
  beginWorkspaceOpenRequest,
  runWorkspaceOpenRequest,
} from "./workspaceOpenRequest";
import { beginWorkspaceOpenTrace } from "./workspaceOpenTrace";
import { initializeWorkspaceStore } from "./workspaceInitialization";
import type { RecoveryCandidate } from "./recovery/types";
import type { WorkspaceState } from "./workspaceState";
import { subscribeWorkspaceLifecycleProjection } from "./workspaceLifecycleProjection";
import { createWorkspaceOpenHandler } from "./workspaceOpenLifecycle";

export type {
  GlobalSettings,
  RecentWorkspace,
} from "@/lib/globalSettings/GlobalSettings";

export type {
  AppView,
  WorkspaceOpenRequestOutcome,
  WorkspaceState,
} from "./workspaceState";
export type { RecoveryCandidate, RecoveryShellState } from "./recovery/types";

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  view: "loading",
  globalSettings: null,
  activeWorkspacePath: null,
  activeWorkspaceId: null,
  workspaceOpenRevision: 0,
  workspaceSwitchInProgress: false,
  workspaceOpenRequestInProgress: false,
  workspaceHydrated: false,
  workspaceLifecycleRevision: 0,
  workspaceLifecycleStatus: "closed",
  workspaceLifecycleActivation: "none",
  workspaceLifecycleBindingToken: null,
  activeWorkspaceName: null,
  error: null,
  pendingTrustPath: null,
  showSampleTour: false,
  recoveryShell: null,

  initialize: () => {
    void subscribeWorkspaceLifecycleProjection(get, set).catch((error) => {
      debugLog.warn(
        "workspaceStore",
        "lifecycle projection subscription unavailable",
        error,
      );
    });
    return initializeWorkspaceStore(get, set);
  },

  openWorkspace: createWorkspaceOpenHandler(get, set),

  async requestOpenWorkspace(path: string, source = "folder-picker") {
    await runWorkspaceOpenRequest({ path, recent: false, source }, get, set);
  },

  async trustAndOpen() {
    const path = get().pendingTrustPath;
    if (!path) return;
    const finish = beginWorkspaceOpenRequest(path, (inProgress) =>
      set({ workspaceOpenRequestInProgress: inProgress }),
    );
    if (!finish) return;
    const trace = beginWorkspaceOpenTrace("trust-confirmed");
    try {
      const trusted = get().globalSettings?.trustedWorkspaces ?? [];
      const saved = await get().updateGlobalSettings({
        trustedWorkspaces: [...trusted, path],
      });
      if (!saved) {
        trace.fail();
        return;
      }
      set({ pendingTrustPath: null });
      const outcome = await get().openWorkspace(path, "trust-confirmed");
      if (outcome !== "opened") trace.fail();
    } catch (error) {
      trace.fail();
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

  async openRecentWorkspace(path: string, source = "direct") {
    await runWorkspaceOpenRequest({ path, recent: true, source }, get, set);
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
    set({ view: "launcher", recoveryShell: null });
  },

  clearError: () => {
    set({ error: null });
  },

  setShowSampleTour: (show: boolean) => {
    set({ showSampleTour: show });
  },

  setRecoveryCandidates: (candidates: RecoveryCandidate[]) => {
    const recoveryShell = get().recoveryShell;
    if (!recoveryShell) return;
    set({ recoveryShell: { ...recoveryShell, candidates } });
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
