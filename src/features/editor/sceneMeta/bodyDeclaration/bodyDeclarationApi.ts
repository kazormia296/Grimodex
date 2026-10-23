/**
 * Renderer wrappers of the Scene body declaration entries (CB-3).
 *
 * The wrappers build only the closed payloads Native accepts: there is no field
 * for a declaration ID, a time, a digest, a grant, a sender or a window, and no
 * function that writes a confirmation text (Main shows Native's own text).
 * They never throw: a failure is a closed refusal code, and a raw error message
 * (which can carry a path) is never returned. `requestId` is made fresh for
 * every call, so a retry or a re-declaration after a revoke is never a replay
 * of an earlier author action.
 */
import { invoke } from "@/lib/tauri";
import {
  BODY_DECLARATION_AXES,
  BODY_DECLARATION_BLOCKERS,
  BODY_DECLARATION_EXPIRY_GROUPS,
  BODY_DECLARATION_REFUSAL_CODES,
  BODY_DECLARATION_UNAVAILABLE_REASONS,
  type BodyDeclarationBlocker,
  type BodyDeclarationDeclareResult,
  type BodyDeclarationExpiryGroup,
  type BodyDeclarationOcc,
  type BodyDeclarationReadResult,
  type BodyDeclarationRefusalCode,
  type BodyDeclarationRevokeOutcome,
  type BodyDeclarationRevokeResult,
  type BodyDeclarationScene,
  type BodyDeclarationSnapshot,
  type BodyDeclarationStateView,
  type BodyDeclarationUnavailableReason,
  type BodyDeclarationValues,
  type ConfirmedAxes,
} from "./bodyDeclarationTypes";

const STATE_COMMAND = "narrative_scene_body_declaration_state";
const DECLARE_COMMAND = "narrative_scene_body_declaration_declare";
const REVOKE_COMMAND = "narrative_scene_body_declaration_revoke";

/** The G-01 subset. The author confirms each axis; the value is not editable. */
export const BODY_DECLARATION_VALUES: BodyDeclarationValues = Object.freeze({
  story: "independent",
  auto: "independent",
  phase: "independent",
  reveal: "non-secret",
  pov: "independent",
});

const STORE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "connection-busy",
  "sqlite-busy",
  "timed-out",
  "fenced",
  "cancelled",
  "connection-unavailable",
  "sql-owner-active",
  "already-exists",
  "conflict",
  "terminal-conflict",
  "claim-mismatch",
  "expired",
  "not-current",
  "missing",
  "invalid",
]);

const GRANT_CODES: Readonly<Record<string, BodyDeclarationRefusalCode>> = {
  MAIN_GRANT_CANCELLED: "grant-cancelled",
  MAIN_GRANT_EXPIRED: "grant-expired",
  MAIN_GRANT_REVOKED: "grant-revoked",
  MAIN_GRANT_BUSY: "grant-busy",
  MAIN_GRANT_REQUIRED: "grant-required",
  MAIN_GRANT_SENDER_UNAVAILABLE: "grant-sender-unavailable",
};

const KNOWN_REFUSAL_CODES: ReadonlySet<string> = new Set(
  BODY_DECLARATION_REFUSAL_CODES,
);
const BLOCKERS: ReadonlySet<string> = new Set(BODY_DECLARATION_BLOCKERS);
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(
  BODY_DECLARATION_UNAVAILABLE_REASONS,
);
const EXPIRY_GROUPS: ReadonlySet<string> = new Set(
  BODY_DECLARATION_EXPIRY_GROUPS,
);

/**
 * Maps a failure to a closed code. Only the code is taken from the message;
 * the message itself (it can carry an absolute path) is dropped.
 */
export function bodyDeclarationRefusalCode(
  error: unknown,
): BodyDeclarationRefusalCode {
  const message = error instanceof Error ? error.message : String(error);
  const native = /NEX_BODY_DECLARATION_REFUSED:([a-z0-9-]+)/u.exec(message);
  if (native) {
    const code = native[1];
    if (KNOWN_REFUSAL_CODES.has(code)) {
      return code as BodyDeclarationRefusalCode;
    }
    if (STORE_FAILURE_CODES.has(code)) return "store-failure";
    return "unknown-refusal";
  }
  const grant = /(MAIN_GRANT_[A-Z_]+)/u.exec(message);
  if (grant) return GRANT_CODES[grant[1]] ?? "grant-failed";
  if (message.includes("D2A_EGRESS_DENIED")) return "egress-denied";
  if (
    message.includes("IPC_TIMEOUT") ||
    /^IPC timeout after \d+ms/u.test(message)
  ) {
    return "timeout";
  }
  return "unknown-refusal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => key in value);
}

function parseBlocker(
  value: unknown,
): BodyDeclarationBlocker | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && BLOCKERS.has(value)) {
    return value as BodyDeclarationBlocker;
  }
  return undefined;
}

function parseOcc(value: unknown): BodyDeclarationOcc | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["scopeVersion", "scopeToken"])
  ) {
    return undefined;
  }
  const { scopeVersion, scopeToken } = value;
  if (
    typeof scopeVersion !== "number" ||
    !Number.isSafeInteger(scopeVersion) ||
    scopeVersion < 1 ||
    typeof scopeToken !== "string" ||
    scopeToken.length === 0
  ) {
    return undefined;
  }
  return { scopeVersion, scopeToken };
}

function parseState(value: unknown): BodyDeclarationStateView | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "none") {
    if (!hasExactKeys(value, ["kind", "blocker"])) return undefined;
    const blocker = parseBlocker(value.blocker);
    return blocker === undefined ? undefined : { kind: "none", blocker };
  }
  if (value.kind === "declared") {
    if (!hasExactKeys(value, ["kind", "effective", "expiredBy", "blocker"])) {
      return undefined;
    }
    const blocker = parseBlocker(value.blocker);
    const { effective, expiredBy } = value;
    if (
      blocker === undefined ||
      typeof effective !== "boolean" ||
      !Array.isArray(expiredBy) ||
      expiredBy.some(
        (group) => typeof group !== "string" || !EXPIRY_GROUPS.has(group),
      ) ||
      new Set(expiredBy).size !== expiredBy.length
    ) {
      return undefined;
    }
    // "Effective" holds only when nothing blocks and nothing expired.
    if (effective && (blocker !== null || expiredBy.length > 0)) {
      return undefined;
    }
    return {
      kind: "declared",
      effective,
      expiredBy: expiredBy as BodyDeclarationExpiryGroup[],
      blocker,
    };
  }
  if (value.kind === "unavailable") {
    if (!hasExactKeys(value, ["kind", "reason", "blocker"])) return undefined;
    const blocker = parseBlocker(value.blocker);
    const { reason } = value;
    if (
      blocker === undefined ||
      typeof reason !== "string" ||
      !UNAVAILABLE_REASONS.has(reason) ||
      reason === "unknown-response"
    ) {
      return undefined;
    }
    return {
      kind: "unavailable",
      reason: reason as BodyDeclarationUnavailableReason,
      blocker,
    };
  }
  return undefined;
}

/** What an unrecognised answer folds to: unusable, never effective. */
const UNKNOWN_SNAPSHOT: BodyDeclarationSnapshot = Object.freeze({
  occ: null,
  declarationToken: null,
  state: Object.freeze({
    kind: "unavailable",
    reason: "unknown-response",
    blocker: null,
  }),
});

/** Parses Native's answer. Anything outside the closed shape folds to unusable. */
export function parseBodyDeclarationSnapshot(
  value: unknown,
): BodyDeclarationSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["occ", "declarationToken", "state"])
  ) {
    return UNKNOWN_SNAPSHOT;
  }
  const occ = parseOcc(value.occ);
  const state = parseState(value.state);
  const token = value.declarationToken;
  if (
    occ === undefined ||
    state === undefined ||
    !(token === null || (typeof token === "string" && token.length > 0))
  ) {
    return UNKNOWN_SNAPSHOT;
  }
  return { occ, declarationToken: token, state };
}

function scenePayload(scene: BodyDeclarationScene) {
  return { projectId: scene.projectId, sceneId: scene.sceneId };
}

/** Reads the state of the Scene's declaration. Never throws. */
export async function readBodyDeclarationState(
  scene: BodyDeclarationScene,
): Promise<BodyDeclarationReadResult> {
  try {
    const value = await invoke<unknown>(STATE_COMMAND, {
      expectedWorkspacePath: scene.workspacePath,
      payload: scenePayload(scene),
    });
    return { ok: true, snapshot: parseBodyDeclarationSnapshot(value) };
  } catch (cause: unknown) {
    return { ok: false, code: bodyDeclarationRefusalCode(cause) };
  }
}

export type DeclareBodyInput = {
  readonly scene: BodyDeclarationScene;
  /** From the same snapshot as `declarationToken`. */
  readonly occ: BodyDeclarationOcc;
  /** The stored declaration's token, or `null` when there is none. */
  readonly declarationToken: string | null;
  /** All five axes, each confirmed by the author. */
  readonly confirmed: ConfirmedAxes;
};

/**
 * Asks Native to declare. Main shows its own one-time confirmation; the
 * wrapper cannot approve and sends no grant. Never throws.
 */
export async function declareBody(
  input: DeclareBodyInput,
): Promise<BodyDeclarationDeclareResult> {
  // Defence in depth: the UI keeps the button disabled until each axis is
  // confirmed, and nothing here defaults an axis.
  if (!BODY_DECLARATION_AXES.every((axis) => input.confirmed[axis] === true)) {
    return { ok: false, code: "invalid-request" };
  }
  try {
    const value = await invoke<unknown>(DECLARE_COMMAND, {
      expectedWorkspacePath: input.scene.workspacePath,
      payload: {
        ...scenePayload(input.scene),
        requestId: crypto.randomUUID(),
        expected: {
          scopeVersion: input.occ.scopeVersion,
          scopeToken: input.occ.scopeToken,
          declarationToken: input.declarationToken,
        },
        values: { ...BODY_DECLARATION_VALUES },
      },
    });
    if (
      isRecord(value) &&
      hasExactKeys(value, ["outcome"]) &&
      value.outcome === "declared"
    ) {
      return { ok: true };
    }
    return { ok: false, code: "unknown-refusal" };
  } catch (cause: unknown) {
    return { ok: false, code: bodyDeclarationRefusalCode(cause) };
  }
}

const REVOKE_OUTCOMES: ReadonlySet<string> = new Set([
  "revoked",
  "no-declaration",
  "declaration-changed",
]);

/**
 * Revokes the declaration whose token the author's screen read. Revoking needs
 * no grant and has no confirmation of its own. Never throws.
 */
export async function revokeBody(input: {
  readonly scene: BodyDeclarationScene;
  readonly declarationToken: string;
}): Promise<BodyDeclarationRevokeResult> {
  try {
    const value = await invoke<unknown>(REVOKE_COMMAND, {
      expectedWorkspacePath: input.scene.workspacePath,
      payload: {
        ...scenePayload(input.scene),
        requestId: crypto.randomUUID(),
        declarationToken: input.declarationToken,
      },
    });
    if (
      isRecord(value) &&
      hasExactKeys(value, ["outcome"]) &&
      typeof value.outcome === "string" &&
      REVOKE_OUTCOMES.has(value.outcome)
    ) {
      return {
        ok: true,
        outcome: value.outcome as BodyDeclarationRevokeOutcome,
      };
    }
    return { ok: false, code: "unknown-refusal" };
  } catch (cause: unknown) {
    return { ok: false, code: bodyDeclarationRefusalCode(cause) };
  }
}
