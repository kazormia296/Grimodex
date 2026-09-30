import { flushStrictQuiescence } from "@/application/lifecycle/quiescenceCoordinator";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { cancelWorkspaceScopedSchedules } from "@/application/workspace/workspaceScheduleQuiescence";
import { clearRetainedEditorRecoveryDraftsForScopeChange } from "@/features/editor/editorSaveRegistry";
import {
  beginWorkspaceSwitch,
  endWorkspaceSwitch,
} from "@/features/timelapse/recorder";
import { acquireQuiescenceLeaseAfterTimelapseGenesis } from "@/features/timelapse/genesisQuiescence";
import { useWorkspaceStore } from "@/features/workspace/store";
import type { WorkspaceRestoreOutcome } from "@/../electron/shared/workspaceRestoreOutcome";
import { applyWorkspaceLifecycleUnchangedProof } from "@/features/workspace/workspaceLifecycleProjection";
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
/** Native rejected this request before it acquired the lifecycle transition. */
export const RESTORE_NOT_ADMITTED = "NEX_WORKSPACE_RESTORE_NOT_ADMITTED";
/** Native proved that the exact previous LiveBinding survived this Restore. */
export const RESTORE_UNCHANGED = "NEX_WORKSPACE_RESTORE_UNCHANGED";

/** Errors that leave Native replaced or unpublished must tear down the UI. */
export function isTerminalRestoreError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes(RESTORE_SESSION_LOST) ||
    message.includes(RESTORE_SESSION_MARKER_FINALIZE_FAILED) ||
    message.includes(RESTORE_FORENSIC_RECOVERY_REQUIRED)
  );
}

export function isRestoreNotAdmittedError(error: unknown): boolean {
  return String(error).includes(RESTORE_NOT_ADMITTED);
}

export function isRestoreUnchangedError(error: unknown): boolean {
  return String(error).includes(RESTORE_UNCHANGED);
}

function hasExactUnchangedProof(
  outcome: WorkspaceRestoreOutcome,
  previous: ReturnType<typeof useWorkspaceStore.getState>,
): boolean {
  if (
    outcome.status !== "unchanged" ||
    outcome.operationOutcome === "succeeded" ||
    outcome.lifecycle.status !== "ready" ||
    outcome.lifecycle.activation !== "ready" ||
    outcome.lifecycle.bindingToken === null ||
    previous.workspaceLifecycleStatus !== "ready" ||
    previous.workspaceLifecycleActivation !== "ready" ||
    previous.workspaceLifecycleBindingToken === null ||
    previous.workspaceLifecycleBindingToken !== outcome.lifecycle.bindingToken
  ) {
    return false;
  }
  const observedRevision = previous.workspaceLifecycleRevision ?? 0;
  const currentRevision =
    useWorkspaceStore.getState().workspaceLifecycleRevision ?? observedRevision;
  // A lifecycle observation newer than this operation's proof invalidates the
  // old binding even when the opaque token happens to be retained by a
  // background projection. The exact revision is the operation boundary.
  return (
    observedRevision <= outcome.lifecycle.revision &&
    currentRevision <= outcome.lifecycle.revision
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
  const previousLifecycle = useWorkspaceStore.getState();
  const projectId = getCurrentProjectId();
  const lease = await acquireQuiescenceLeaseAfterTimelapseGenesis(
    "workspace-restore",
    {
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
    },
  );
  let switchStarted = false;
  let rendererTerminal = false;
  let rendererNotAdmitted = false;
  let rendererUnchangedProof = false;

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
      const outcome = await restoreBackup(fileName);
      if (
        outcome.status === "restored" &&
        outcome.operationOutcome === "succeeded" &&
        outcome.lifecycle.status === "ready" &&
        outcome.lifecycle.activation === "ready" &&
        outcome.activation === "ready"
      ) {
        rendererTerminal = true;
      } else if (
        outcome.status === "unchanged" &&
        hasExactUnchangedProof(outcome, previousLifecycle)
      ) {
        // Only this strict operation-scoped proof may return the old binding.
        // The lifecycle token and revision must still match the renderer's
        // last Ready observation; a string error marker is never sufficient.
        if (
          !applyWorkspaceLifecycleUnchangedProof(
            useWorkspaceStore.getState,
            useWorkspaceStore.setState,
            outcome.lifecycle,
          )
        ) {
          rendererTerminal = true;
          throw new Error(
            `${RESTORE_FORENSIC_RECOVERY_REQUIRED}: unchanged proof could not resume the lifecycle projection`,
          );
        }
        rendererUnchangedProof = true;
        throw new Error(
          `${RESTORE_UNCHANGED}: restore left the exact binding unchanged`,
        );
      } else if (outcome.status === "not-admitted") {
        rendererNotAdmitted = true;
        throw new Error(
          `${RESTORE_NOT_ADMITTED}: ${outcome.reasonCode ?? "lifecycle-not-admitted"}`,
        );
      } else if (
        outcome.status === "activated" &&
        outcome.lifecycle.status === "ready" &&
        outcome.lifecycle.activation === "ready" &&
        outcome.activation === "ready" &&
        outcome.operationOutcome !== "succeeded"
      ) {
        // The replacement authority is published but the operation failed;
        // the old renderer binding is invalid and must be torn down.
        rendererTerminal = true;
        throw new Error(
          `${RESTORE_FORENSIC_RECOVERY_REQUIRED}: restore activated a replacement after failure`,
        );
      } else {
        rendererTerminal = true;
        throw new Error(
          `${RESTORE_FORENSIC_RECOVERY_REQUIRED}: restore did not prove a resumable lifecycle outcome`,
        );
      }
    } catch (error) {
      if (isTerminalRestoreError(error)) {
        rendererTerminal = true;
      } else if (isRestoreNotAdmittedError(error)) {
        // The Native request never acquired the transition. The concurrent
        // owner may still be draining/replacing the workspace, so never
        // restore hydration, IME, recorder, or the old binding.
        rendererNotAdmitted = true;
      } else if (isRestoreUnchangedError(error)) {
        // The proof was checked above. Keep the old scope alive, but continue
        // surfacing the failed Restore to the caller.
      }
      throw error;
    }
  } finally {
    if (switchStarted) {
      endWorkspaceSwitch({
        restoreBinding:
          !rendererTerminal && !rendererNotAdmitted && rendererUnchangedProof,
      });
    }
    if (!rendererTerminal && !rendererNotAdmitted && rendererUnchangedProof) {
      setCurrentWorkspaceIdentity(previousIdentity);
    }
    lease.release({
      disposition: rendererTerminal ? "renderer-teardown" : "resume",
    });
  }
}
