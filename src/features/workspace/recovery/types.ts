export type RecoveryCandidateKind =
  | "automatic-backup"
  | "manual-backup"
  | "migration-snapshot";

export type RecoveryChecksumStatus = "verified" | "unverified" | "invalid";

export interface RecoveryCandidate {
  id: string;
  kind: RecoveryCandidateKind;
  createdAt: string;
  schemaVersion: number | null;
  appVersion: string | null;
  sizeBytes: number;
  checksumStatus: RecoveryChecksumStatus;
}

export interface NativeWorkspacePayload {
  name: string;
  isExisting: boolean;
  workspaceId?: string;
}

export interface MigrationReceipt {
  fromSchema: number;
  toSchema: number;
  receiptPath: string;
  recovered: boolean;
  errorCode?: string;
}

export type NativeWorkspaceOpenOutcome =
  | { status: "ready"; workspace: NativeWorkspacePayload }
  | {
      status: "migrated";
      workspace: NativeWorkspacePayload;
      migration: MigrationReceipt;
    }
  | {
      status: "recovery-required";
      reason: string;
      errorCode: string;
      snapshotId?: string;
      candidates: RecoveryCandidate[];
    }
  | {
      status: "safe-mode";
      reason: string;
      candidates: RecoveryCandidate[];
    }
  | {
      status: "not-admitted";
      reasonCode: string;
      snapshot: {
        state:
          | "no-workspace"
          | "ready"
          | "transition"
          | "recovery-required"
          | "closed";
        revision: number;
        phase?: "draining" | "replacing" | "recovering" | "finishing";
      };
    };

export interface RecoveryShellState {
  mode: "safe-mode" | "recovery-required";
  workspacePath: string;
  reason: string;
  errorCode?: string;
  snapshotId?: string;
  candidates: RecoveryCandidate[];
}

type LegacyWorkspaceOpenPayload = {
  name: string;
  isExisting?: boolean;
  workspaceId?: string;
};

function isNativeWorkspaceOpenOutcome(
  value: unknown,
): value is NativeWorkspaceOpenOutcome {
  return (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof (value as { status?: unknown }).status === "string"
  );
}

export function normalizeNativeWorkspaceOpenOutcome(
  value: NativeWorkspaceOpenOutcome | LegacyWorkspaceOpenPayload,
): NativeWorkspaceOpenOutcome {
  if (isNativeWorkspaceOpenOutcome(value)) return value;

  return {
    status: "ready",
    workspace: {
      name: value.name,
      isExisting: value.isExisting ?? true,
      workspaceId: value.workspaceId,
    },
  };
}
