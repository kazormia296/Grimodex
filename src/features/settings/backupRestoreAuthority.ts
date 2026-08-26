import { flushStrictQuiescence } from "@/application/lifecycle/quiescenceCoordinator";
import { acquireQuiescenceLease } from "@/application/lifecycle/quiescenceLease";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { cancelWorkspaceScopedSchedules } from "@/application/workspace/workspaceScheduleQuiescence";
import { clearRetainedEditorRecoveryDraftsForScopeChange } from "@/features/editor/editorSaveRegistry";
import {
  beginWorkspaceSwitch,
  endWorkspaceSwitch,
} from "@/features/timelapse/recorder";
import {
  getCurrentWorkspaceIdentity,
  setCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { restoreBackup } from "./backupApi";

/**
 * Rust reports this only after the replacement image was committed but the
 * replacement session could not be reopened. The renderer must be treated as
 * terminal in that state just as it is after a successful restore.
 */
export const RESTORE_SESSION_LOST = "RESTORE_SESSION_LOST";
export const RESTORE_SESSION_MARKER_FINALIZE_FAILED =
  "RESTORE_SESSION_MARKER_FINALIZE_FAILED";
export const RESTORE_FORENSIC_RECOVERY_REQUIRED =
  "RESTORE_FORENSIC_RECOVERY_REQUIRED";

/** Errors that leave Native replaced or unpublished must tear down the UI. */
export function isTerminalRestoreError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes(RESTORE_SESSION_LOST) ||
    message.includes(RESTORE_SESSION_MARKER_FINALIZE_FAILED) ||
    message.includes(RESTORE_FORENSIC_RECOVERY_REQUIRED)
  );
}

/**
 * Replaces the active database behind the canonical Workspace quiescence
 * boundary. The lease is intentionally short of the subsequent page reload,
 * but a committed replacement releases it as renderer-teardown so no old-scope
 * continuation can start in the interval before the browser destroys the page.
 */
export async function restoreBackupWithWorkspaceAuthority(
  fileName: string,
): Promise<void> {
  const previousIdentity = getCurrentWorkspaceIdentity();
  if (!previousIdentity) {
    throw new Error(
      "NEX_WORKSPACE_RESTORE_AUTHORITY_UNAVAILABLE: cannot restore without a published Workspace identity",
    );
  }
  const projectId = getCurrentProjectId();
  const lease = acquireQuiescenceLease("workspace-restore", {
    transition: {
      kind: "workspace",
      from: {
        workspacePath: previousIdentity.path,
        workspaceOpenRevision: previousIdentity.openRevision,
        projectId,
      },
      to: {
        workspacePath: previousIdentity.path,
        workspaceOpenRevision: null,
        projectId: null,
      },
    },
  });
  let switchStarted = false;
  let rendererTerminal = false;

  try {
    // Stop debounced work before the first await. The lease blocks new scoped
    // mutations while strict quiescence drains captures and writes admitted
    // before this replacement began.
    cancelWorkspaceScopedSchedules();
    await flushStrictQuiescence(undefined, {
      transition: lease.transition,
    });
    clearRetainedEditorRecoveryDraftsForScopeChange();

    // Keep the old identity published while old-scope persistence drains. It
    // becomes invalid only for the exact native replacement window.
    setCurrentWorkspaceIdentity(null);
    beginWorkspaceSwitch();
    switchStarted = true;
    lease.sealReadsForAuthorityCommit();
    try {
      await restoreBackup(fileName);
      rendererTerminal = true;
    } catch (error) {
      if (isTerminalRestoreError(error)) {
        rendererTerminal = true;
      }
      throw error;
    }
  } finally {
    if (switchStarted) {
      endWorkspaceSwitch({ restoreBinding: !rendererTerminal });
    }
    if (!rendererTerminal) {
      setCurrentWorkspaceIdentity(previousIdentity);
    }
    lease.release({
      disposition: rendererTerminal ? "renderer-teardown" : "resume",
    });
  }
}
