import type { WorkspaceState } from "../workspaceState";
import {
  normalizeNativeWorkspaceOpenOutcome,
  type NativeWorkspaceOpenOutcome,
  type NativeWorkspacePayload,
} from "./types";

export type NativeWorkspaceOpenResult =
  | NativeWorkspaceOpenOutcome
  | NativeWorkspacePayload;

type RecoveryWorkspaceOpenStatus = Extract<
  NativeWorkspaceOpenOutcome["status"],
  "safe-mode" | "recovery-required"
>;

type RecoveryWorkspaceStatePatch = Pick<
  WorkspaceState,
  | "view"
  | "activeWorkspacePath"
  | "activeWorkspaceId"
  | "activeWorkspaceName"
  | "error"
  | "workspaceHydrated"
  | "recoveryShell"
>;

type AppliedNativeOpenOutcome =
  | {
      kind: "ready";
      workspace: NativeWorkspacePayload;
    }
  | {
      kind: "recovery";
      status: RecoveryWorkspaceOpenStatus;
      state: RecoveryWorkspaceStatePatch;
    };

export function applyNativeOpenOutcome(
  value: NativeWorkspaceOpenResult,
  workspacePath: string,
): AppliedNativeOpenOutcome {
  const outcome = normalizeNativeWorkspaceOpenOutcome(value);

  if (
    outcome.status === "safe-mode" ||
    outcome.status === "recovery-required"
  ) {
    return {
      kind: "recovery",
      status: outcome.status,
      state: {
        view: "recovery",
        activeWorkspacePath: null,
        activeWorkspaceId: null,
        activeWorkspaceName: null,
        error: null,
        workspaceHydrated: false,
        recoveryShell: {
          mode: outcome.status,
          workspacePath,
          reason: outcome.reason,
          ...(outcome.status === "recovery-required"
            ? { errorCode: outcome.errorCode }
            : {}),
          ...(outcome.status === "recovery-required" && outcome.snapshotId
            ? { snapshotId: outcome.snapshotId }
            : {}),
          candidates: outcome.candidates,
        },
      },
    };
  }

  return {
    kind: "ready",
    workspace: outcome.workspace,
  };
}
