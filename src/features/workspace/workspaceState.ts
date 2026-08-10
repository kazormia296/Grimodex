import type { GlobalSettings } from "@/lib/globalSettings/GlobalSettings";
import type { WorkspaceOpenTraceSource } from "./workspaceOpenTrace";
import type { RecoveryCandidate, RecoveryShellState } from "./recovery/types";

export type AppView =
  | "loading"
  | "welcome"
  | "launcher"
  | "editor"
  | "recovery";

export type WorkspaceOpenRequestOutcome =
  | "opened"
  | "blocked"
  | "failed"
  | "in-progress"
  | "safe-mode"
  | "recovery-required";

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
  /** In-memory only - not persisted. True while SampleTour should be shown. */
  showSampleTour: boolean;
  recoveryShell: RecoveryShellState | null;

  initialize: () => Promise<void>;
  openWorkspace: (
    path: string,
    source?: WorkspaceOpenTraceSource,
  ) => Promise<WorkspaceOpenRequestOutcome>;
  requestOpenWorkspace: (
    path: string,
    source?: WorkspaceOpenTraceSource,
  ) => Promise<void>;
  openRecentWorkspace: (
    path: string,
    source?: WorkspaceOpenTraceSource,
  ) => Promise<void>;
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
  setRecoveryCandidates: (candidates: RecoveryCandidate[]) => void;
  /** Seed sample workspace, open it, and flag tour to show. */
  seedAndOpenSample: (language: string, aiPolicy: string) => Promise<void>;
}
