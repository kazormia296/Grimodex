/**
 * Closed vocabularies of the Scene body declaration UI (CB-3).
 *
 * Every code here is a code Native or Main can answer with. Anything else is
 * folded into `unknown-response` / `unknown-refusal` by the wrapper, so no
 * unknown string and no raw message reaches a component.
 */

/** A reason a declaration is impossible right now (a state of the Scene). */
export const BODY_DECLARATION_BLOCKERS = [
  "scene-not-found",
  "scene-archived",
  "scope-unavailable",
  "scope-not-explicit",
  "scope-unresolved",
  "body-empty",
  "body-too-large",
  "body-unreadable",
  "title-too-large",
  "locator-unavailable",
  "veto-secret-foreshadow",
  "veto-secret-event-reveal",
  "veto-secret-event-link",
  "veto-pov",
  "veto-limit",
  "declaration-unreadable",
] as const;
export type BodyDeclarationBlocker = (typeof BODY_DECLARATION_BLOCKERS)[number];

/** Why a stored declaration cell cannot be used. */
export const BODY_DECLARATION_UNAVAILABLE_REASONS = [
  "binding-row-missing",
  "half-state",
  "oversized",
  "malformed",
  "unsupported-version",
  "unknown-field",
  "token-mismatch",
  "scene-key-mismatch",
  // The wrapper's own fold for an answer it could not recognise.
  "unknown-response",
] as const;
export type BodyDeclarationUnavailableReason =
  (typeof BODY_DECLARATION_UNAVAILABLE_REASONS)[number];

/** Four groups a stored declaration can expire by. */
export const BODY_DECLARATION_EXPIRY_GROUPS = [
  "content",
  "scope",
  "identity",
  "workspace",
] as const;
export type BodyDeclarationExpiryGroup =
  (typeof BODY_DECLARATION_EXPIRY_GROUPS)[number];

/** Refusals that are not a state of the Scene (a write or a read failed). */
const OPERATION_REFUSALS = [
  "gate-closed",
  "restart-required",
  "workspace-mismatch",
  "invalid-request",
  "state-changed",
  "display-mismatch",
  "request-conflict",
  "commit-failed",
  "internal",
  // Native's bounded-store failures (busy, timed out, fenced, ...) folded.
  "store-failure",
  // Main's one-time confirmation did not end in an approval.
  "grant-cancelled",
  "grant-expired",
  "grant-revoked",
  "grant-busy",
  "grant-required",
  "grant-sender-unavailable",
  "grant-failed",
  // The renderer-side fold of the caller admission and the IPC timeout.
  "egress-denied",
  "timeout",
  "unknown-refusal",
] as const;

export type BodyDeclarationRefusalCode =
  | BodyDeclarationBlocker
  | (typeof OPERATION_REFUSALS)[number];

export const BODY_DECLARATION_REFUSAL_CODES: readonly BodyDeclarationRefusalCode[] =
  [...BODY_DECLARATION_BLOCKERS, ...OPERATION_REFUSALS];

/** The v1 subset: the one value each axis can take. */
export const BODY_DECLARATION_AXES = [
  "story",
  "auto",
  "phase",
  "reveal",
  "pov",
] as const;
export type BodyDeclarationAxis = (typeof BODY_DECLARATION_AXES)[number];

export type BodyDeclarationValues = {
  readonly story: "independent";
  readonly auto: "independent";
  readonly phase: "independent";
  readonly reveal: "non-secret";
  readonly pov: "independent";
};

/** Each axis explicitly confirmed by the author (never defaulted). */
export type ConfirmedAxes = Readonly<Record<BodyDeclarationAxis, boolean>>;

/** The opaque values the next declare names (read in the same snapshot). */
export type BodyDeclarationOcc = {
  readonly scopeVersion: number;
  readonly scopeToken: string;
};

export type BodyDeclarationStateView =
  | {
      readonly kind: "none";
      readonly blocker: BodyDeclarationBlocker | null;
    }
  | {
      readonly kind: "declared";
      readonly effective: boolean;
      readonly expiredBy: readonly BodyDeclarationExpiryGroup[];
      readonly blocker: BodyDeclarationBlocker | null;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: BodyDeclarationUnavailableReason;
      readonly blocker: BodyDeclarationBlocker | null;
    };

/** One Native snapshot: the state and the OCC values read together. */
export type BodyDeclarationSnapshot = {
  readonly occ: BodyDeclarationOcc | null;
  readonly declarationToken: string | null;
  readonly state: BodyDeclarationStateView;
};

export type BodyDeclarationScene = {
  readonly workspacePath: string;
  readonly projectId: string;
  readonly sceneId: string;
};

export type BodyDeclarationReadResult =
  | { readonly ok: true; readonly snapshot: BodyDeclarationSnapshot }
  | { readonly ok: false; readonly code: BodyDeclarationRefusalCode };

export type BodyDeclarationDeclareResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: BodyDeclarationRefusalCode };

export type BodyDeclarationRevokeOutcome =
  | "revoked"
  | "no-declaration"
  | "declaration-changed";

export type BodyDeclarationRevokeResult =
  | { readonly ok: true; readonly outcome: BodyDeclarationRevokeOutcome }
  | { readonly ok: false; readonly code: BodyDeclarationRefusalCode };
