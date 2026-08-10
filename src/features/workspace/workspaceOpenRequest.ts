import i18next from "@/lib/i18n";
import { invoke } from "@/lib/tauri";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { toast } from "sonner";
import type { WorkspaceState } from "./store";
import {
  beginWorkspaceOpenTrace,
  type WorkspaceOpenTraceSource,
} from "./workspaceOpenTrace";

export type WorkspaceOpenRequestOutcome =
  | "opened"
  | "blocked"
  | "failed"
  | "in-progress"
  | "safe-mode"
  | "recovery-required";

type WorkspaceStoreGetter = () => WorkspaceState;
type WorkspaceStoreSetter = (partial: Partial<WorkspaceState>) => void;

let workspaceOpenRequestInFlight = false;

export function beginWorkspaceOpenRequest(
  path: string,
  setInProgress: (inProgress: boolean) => void,
): (() => void) | null {
  if (workspaceOpenRequestInFlight) {
    debugLog.warn(
      "workspaceStore",
      "workspace open request already in flight; ignoring re-entry",
      path,
    );
    toast.info(i18next.t("workspace.openInProgress"));
    return null;
  }

  workspaceOpenRequestInFlight = true;
  setInProgress(true);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    workspaceOpenRequestInFlight = false;
    setInProgress(false);
  };
}

async function openValidatedWorkspace(
  path: string,
  isExisting: boolean,
  get: WorkspaceStoreGetter,
  set: WorkspaceStoreSetter,
): Promise<WorkspaceOpenRequestOutcome | "trust-required"> {
  if (!isExisting) {
    const outcome = await get().openWorkspace(path);
    if (outcome !== "opened") return outcome;

    // Trust only a Workspace that actually became the hydrated authority.
    const currentTrusted = get().globalSettings?.trustedWorkspaces ?? [];
    if (!currentTrusted.includes(path)) {
      await get().updateGlobalSettings({
        trustedWorkspaces: [...currentTrusted, path],
      });
    }
    return outcome;
  }

  const trusted = get().globalSettings?.trustedWorkspaces ?? [];
  if (trusted.includes(path)) {
    return get().openWorkspace(path);
  } else {
    set({ pendingTrustPath: path });
    return "trust-required";
  }
}

export async function runWorkspaceOpenRequest(
  input: {
    path: string;
    recent: boolean;
    source: WorkspaceOpenTraceSource;
  },
  get: WorkspaceStoreGetter,
  set: WorkspaceStoreSetter,
): Promise<void> {
  const finish = beginWorkspaceOpenRequest(input.path, (inProgress) =>
    set({ workspaceOpenRequestInProgress: inProgress }),
  );
  if (!finish) return;
  const trace = beginWorkspaceOpenTrace(input.source);

  try {
    const validationSpan = trace.startSpan("path-validation");
    let isExisting: boolean;
    try {
      isExisting = await invoke<boolean>("validate_workspace_path", {
        path: input.path,
      });
      validationSpan.finish();
    } catch (error) {
      validationSpan.fail();
      throw error;
    }
    if (input.recent && !isExisting) {
      const current = get().globalSettings;
      if (current) {
        await get().updateGlobalSettings({
          recentWorkspaces: current.recentWorkspaces.filter(
            (workspace) => workspace.path !== input.path,
          ),
        });
      }
      set({
        error: i18next.t("workspace.invalidPath", { path: input.path }),
      });
      trace.fail();
      return;
    }

    const outcome = await openValidatedWorkspace(
      input.path,
      isExisting,
      get,
      set,
    );
    if (outcome !== "opened") trace.fail();
  } catch (error) {
    trace.fail();
    debugLog.error(
      "workspaceStore",
      "workspace open request failed",
      errorDetail(error),
    );
    set({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    finish();
  }
}
