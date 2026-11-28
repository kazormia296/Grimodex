export const AGENT_RUN_STATUSES = [
  "running",
  "waiting_user",
  "waiting_approval",
  "finalizing",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
  "discarded",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_RUN_INTERACTION_STATUSES = [
  "pending",
  "resolved",
  "cancelled",
  "superseded",
  "expired",
] as const;
export type AgentRunInteractionStatus =
  (typeof AGENT_RUN_INTERACTION_STATUSES)[number];

export const APPROVAL_RESOLUTIONS = ["approved", "rejected"] as const;
export type ApprovalResolution = (typeof APPROVAL_RESOLUTIONS)[number];

export type AnalysisReadBasisEntryV1 = {
  readonly sourceKind: string;
  readonly sourceId: string;
} & (
  | { readonly version: string; readonly contentHash?: never }
  | { readonly contentHash: string; readonly version?: never }
);

export const AGENT_RUN_CAPABILITY_STATES = [
  "not_issued",
  "awaiting_approval",
  "issued",
  "consumed",
] as const;
export type AgentRunCapabilityState =
  (typeof AGENT_RUN_CAPABILITY_STATES)[number];

export const AGENT_RUN_EXECUTION_STATES = [
  "pending",
  "committed",
  "failed",
] as const;
export type AgentRunExecutionState =
  (typeof AGENT_RUN_EXECUTION_STATES)[number];

export const AGENT_RUN_INTERRUPT_REASONS = [
  "app_shutdown",
  "renderer_lost",
  "workspace_switched",
  "profile_switched",
  "question_timeout",
  "approval_timeout",
  "copied_snapshot",
] as const;
export type AgentRunInterruptReason =
  (typeof AGENT_RUN_INTERRUPT_REASONS)[number];

export const AGENT_RUN_NOT_RESUMABLE_REASONS = [
  "checkpoint_write_failed",
  "ledger_write_failed",
  "hidden_source_read",
  "route_unsupported",
  "restored_from_copy",
] as const;
export type AgentRunNotResumableReason =
  (typeof AGENT_RUN_NOT_RESUMABLE_REASONS)[number];

export const AGENT_RUN_RESUME_BLOCK_REASONS = [
  "license_restricted",
  "ai_policy",
  "profile_egress",
  "route_unavailable",
  "provider_unavailable",
  "model_unavailable",
  "endpoint_changed",
] as const;
export type AgentRunResumeBlockReason =
  (typeof AGENT_RUN_RESUME_BLOCK_REASONS)[number];

export const AGENT_RUN_TERMINAL_REASONS = [
  "completed",
  "limit_tokens",
  "output_truncated",
  "context_window_exceeded",
  "provider_error",
  "record_failed",
  "timeout",
  "user_stop",
  "policy_revoked",
  "license_restricted",
  "permission_denied",
  "authority_lost",
  "resume_unsupported",
  "discarded_by_author",
  "superseded_by_new_turn",
] as const;
export type AgentRunTerminalReason =
  (typeof AGENT_RUN_TERMINAL_REASONS)[number];

export const AGENT_RUN_ERROR_CODES = [
  "AGENT_RUN_ACTIVE_SESSION_EXISTS",
  "AGENT_RUN_ACTIVITY_AGE_REQUIRED",
  "AGENT_RUN_ACTIVITY_TOO_RECENT",
  "AGENT_RUN_APPROVAL_ANSWER_NOT_ALLOWED",
  "AGENT_RUN_ASSISTANT_MESSAGE_ID_INVALID",
  "AGENT_RUN_ASSISTANT_MESSAGE_ID_MISMATCH",
  "AGENT_RUN_AUDIT_EXECUTION_IDS_LIMIT",
  "AGENT_RUN_CHECKPOINT_INVALID",
  "AGENT_RUN_CHECKPOINT_STEP_MISMATCH",
  "AGENT_RUN_CLAIM_ANSWER_MISMATCH",
  "AGENT_RUN_CLAIM_IDEMPOTENCY_CONFLICT",
  "AGENT_RUN_CLAIM_REPLAY_STALE",
  "AGENT_RUN_DUPLICATE_TOOL_CALL_ID",
  "AGENT_RUN_EMPTY_TOOL_CALL_BATCH",
  "AGENT_RUN_EXECUTION_ID_INVALID",
  "AGENT_RUN_FINALIZING_EVIDENCE_MISSING",
  "AGENT_RUN_INVALID_FINALIZING_TARGET",
  "AGENT_RUN_INVALID_TERMINAL_TARGET",
  "AGENT_RUN_LOCK_PATH_INVALID",
  "AGENT_RUN_NOT_FOUND",
  "AGENT_RUN_NOT_RESUMABLE",
  "AGENT_RUN_OWNER_ID_INVALID",
  "AGENT_RUN_OWNER_LOCK_BUSY",
  "AGENT_RUN_OWNER_MISMATCH",
  "AGENT_RUN_OWNER_RECOVERY_FAILED",
  "AGENT_RUN_PENDING_INTERACTION_EXISTS",
  "AGENT_RUN_REQUEST_TOO_LARGE",
  "AGENT_RUN_SESSION_MISMATCH",
  "AGENT_RUN_SESSION_PROJECT_MISMATCH",
  "AGENT_RUN_SNAPSHOT_CLEANUP_FAILED",
  "AGENT_RUN_SNAPSHOT_SCRUB_FAILED",
  "AGENT_RUN_TARGET_BASIS_INVALID",
  "AGENT_RUN_TERMINAL",
  "AGENT_RUN_TOOL_CALL_BATCH_EXECUTION_MISMATCH",
  "AGENT_RUN_TOOL_CALL_EXECUTION_MISMATCH",
  "AGENT_RUN_TOOL_CALL_ID_INVALID",
  "AGENT_RUN_TOOL_CALL_MISMATCH",
  "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID",
  "AGENT_RUN_UNFINISHED_SESSION_EXISTS",
  "AGENT_RUN_UNKNOWN_TOOL_CALL_ID",
  "AGENT_RUN_VERSION_OR_STATUS_MISMATCH",
] as const;
export type AgentRunErrorCode = (typeof AGENT_RUN_ERROR_CODES)[number];

export function parseAgentRunErrorCode(
  error: unknown,
): AgentRunErrorCode | null {
  const message = error instanceof Error ? error.message : error;
  if (typeof message !== "string") return null;

  for (const [marker] of message.matchAll(/\bAGENT_RUN_[A-Z0-9_]+\b/gu)) {
    const code = AGENT_RUN_ERROR_CODES.find((known) => known === marker);
    if (code !== undefined) return code;
  }
  return null;
}
