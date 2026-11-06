import { hasIpcErrorCode } from "@/lib/ipcOutcome";

/**
 * Stable marker that Core (`AppError::WorkspaceQuarantined`,
 * `grimodex-db/src/error.rs`) puts in the rejection of a DB access while a
 * C-query quarantine fences the workspace. Keep it identical to the Rust
 * literal (change both together).
 *
 * Unlike `WORKSPACE_SWITCHING`, the fence is held until the process restarts,
 * so retrying cannot clear it. Autosave uses this to stop retrying and to tell
 * the author that unsaved text must be copied out before restarting.
 */
export const WORKSPACE_QUARANTINED_MARKER = "WORKSPACE_QUARANTINED";

/** True when the error (or any wrapped cause/detail) is a quarantine refusal. */
export function isWorkspaceQuarantinedError(e: unknown): boolean {
  return hasIpcErrorCode(e, WORKSPACE_QUARANTINED_MARKER);
}
