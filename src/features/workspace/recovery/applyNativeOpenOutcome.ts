import type { WorkspaceState } from "../workspaceState";
import {
  normalizeNativeWorkspaceOpenOutcome,
  type NativeWorkspaceOpenOutcome,
  type NativeWorkspacePayload,
  type NativeWorkspaceLifecycleProof,
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
      lifecycle: NativeWorkspaceLifecycleProof | null;
    }
  | {
      kind: "recovery";
      status: RecoveryWorkspaceOpenStatus;
      state: RecoveryWorkspaceStatePatch;
    }
  | {
      kind: "not-admitted";
      reasonCode: string;
      revision: number;
    }
  | {
      kind: "invalid";
      reasonCode: string;
    };

export function applyNativeOpenOutcome(
  value: NativeWorkspaceOpenResult,
  workspacePath: string,
): AppliedNativeOpenOutcome {
  const structuredOutcome =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "status" in value;
  const outcome = normalizeNativeWorkspaceOpenOutcome(value);

  if (outcome.status === "not-admitted") {
    return {
      kind: "not-admitted",
      reasonCode: outcome.reasonCode,
      revision: outcome.snapshot.revision,
    };
  }

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

  if (structuredOutcome && !isReadyLifecycleProof(outcome)) {
    // A current Native backend must bind the Open result to the exact Ready
    // revision/token it published. Treat a missing or malformed proof as an
    // invalid response and require a fresh query/retry; do not hydrate a
    // renderer scope from an unbound success.
    return {
      kind: "invalid",
      reasonCode: "NEX_WORKSPACE_OPEN_LIFECYCLE_PROOF_MISSING",
    };
  }

  return {
    kind: "ready",
    workspace: outcome.workspace,
    lifecycle: isReadyLifecycleProof(outcome) ? outcome.lifecycle ?? null : null,
  };
}

function isReadyLifecycleProof(
  outcome: Extract<
    NativeWorkspaceOpenOutcome,
    { status: "ready" | "migrated" }
  >,
): boolean {
  const candidate = outcome.lifecycle;
  return (
    candidate !== undefined &&
    candidate !== null &&
    candidate.schemaVersion === 1 &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision >= 0 &&
    candidate.status === "ready" &&
    typeof candidate.bindingToken === "string" &&
    candidate.bindingToken.trim() !== "" &&
    candidate.activation === "ready"
  );
}
