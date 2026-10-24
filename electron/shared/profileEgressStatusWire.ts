/**
 * The profile egress state as the renderer may see it (NIR-1 DA-2,
 * DR-DA2-9 and DR-DA2-16 in `docs/plans/nir1-lane-decisions/da2-decisions.md`).
 *
 * Everything here is a closed union of codes. No value carries plaintext, a
 * path, the profile ID, an epoch, a preview ID or a grant ID. Electron main
 * builds these values; the renderer only reads them (the request command is
 * the only way to ask for a change, and Main decides).
 */

/** Main-processed command: asks Main to run the profile activation. */
export const PROFILE_ACTIVATION_REQUEST_COMMAND = "request_profile_activation";
/** Main-processed command: the current state. Answers while unavailable too. */
export const PROFILE_EGRESS_STATUS_COMMAND = "get_profile_egress_status";
/** Main event sent to every window at stage 2, stage 6 and on a failure. */
export const PROFILE_EGRESS_STATE_EVENT = "profile-egress:state";

export const PROFILE_EGRESS_UNAVAILABLE_REASONS = [
  // Native (`PROFILE_EGRESS_UNAVAILABLE:<code>`, DR-DA2-8)
  "state-file-unreadable",
  "state-file-unwritable",
  "barrier-timeout",
  "activation-failed",
  // Main, stage 3 (DR-DA2-17)
  "participant-timeout",
  "participant-failed",
  // Main, startup (DR-DA2-19)
  "backend-unavailable",
  "status-invalid",
] as const;

export type ProfileEgressUnavailableReason =
  (typeof PROFILE_EGRESS_UNAVAILABLE_REASONS)[number];

export type ProfileEgressStatusView =
  | { readonly state: "unrestricted" }
  | { readonly state: "activating" }
  | { readonly state: "restricted" }
  | {
      readonly state: "unavailable";
      readonly reason: ProfileEgressUnavailableReason;
    };

export type ProfileEgressState = ProfileEgressStatusView["state"];

export const PROFILE_ACTIVATION_REQUEST_STATUSES = [
  "activated",
  "cancelled",
  "expired",
  "busy",
  "already-restricted",
  "unavailable",
  /** Before PUB-G: Native's pre-publication gate is closed (A-1). */
  "not-activated",
  /** Any other refusal (sender, window or caller binding, display, ...). */
  "refused",
] as const;

export type ProfileActivationRequestStatus =
  (typeof PROFILE_ACTIVATION_REQUEST_STATUSES)[number];

export interface ProfileActivationRequestResult {
  readonly status: ProfileActivationRequestStatus;
}

const REASONS: ReadonlySet<string> = new Set(
  PROFILE_EGRESS_UNAVAILABLE_REASONS,
);
const REQUEST_STATUSES: ReadonlySet<string> = new Set(
  PROFILE_ACTIVATION_REQUEST_STATUSES,
);

export function isProfileEgressUnavailableReason(
  value: unknown,
): value is ProfileEgressUnavailableReason {
  return typeof value === "string" && REASONS.has(value);
}

function exactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
  );
}

/** Strict parse; anything outside the closed union is `null`. */
export function parseProfileEgressStatusView(
  value: unknown,
): ProfileEgressStatusView | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  switch (record.state) {
    case "unrestricted":
    case "activating":
    case "restricted":
      return exactKeys(record, ["state"]) ? { state: record.state } : null;
    case "unavailable":
      return exactKeys(record, ["state", "reason"]) &&
        isProfileEgressUnavailableReason(record.reason)
        ? { state: "unavailable", reason: record.reason }
        : null;
    default:
      return null;
  }
}

export function parseProfileActivationRequestResult(
  value: unknown,
): ProfileActivationRequestResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return exactKeys(record, ["status"]) &&
    typeof record.status === "string" &&
    REQUEST_STATUSES.has(record.status)
    ? { status: record.status as ProfileActivationRequestStatus }
    : null;
}
