/**
 * Main-only parser for the workspace lifecycle result wire.
 *
 * This module deliberately sits outside the renderer IPC command table.  A
 * lifecycle result is an observation of a Native operation, not a renderer
 * authorization.  In particular, `not-admitted` only says that the request
 * did not start; it never grants permission to resume the binding that was
 * current before the request arrived.
 */

export type WorkspaceLifecycleState =
  | "no-workspace"
  | "ready"
  | "transition"
  | "recovery-required"
  | "closed";

export type WorkspaceLifecycleTransitionPhase =
  | "draining"
  | "replacing"
  | "recovering"
  | "finishing";

export type WorkspaceLifecycleActivation = "ready" | "requires-open";

export type WorkspaceLifecycleOperationOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type WorkspaceLifecycleContentEffect = "none" | "retained" | "replaced";

export type WorkspaceLifecycleStatus =
  | "not-admitted"
  | "pending"
  | "unchanged"
  | "activated"
  | "restored"
  | "recovery-required"
  | "closed";

export interface WorkspaceLifecycleBinding {
  /** Workspace identity, not a filesystem path. */
  readonly workspaceId: string;
  /** Native authority instance identity. */
  readonly authorityId: string;
  /** Monotonic lifecycle/recovery generation. */
  readonly generation: number;
}

export interface WorkspaceLifecycleSnapshot {
  readonly state: WorkspaceLifecycleState;
  readonly revision: number;
  readonly phase?: WorkspaceLifecycleTransitionPhase;
  readonly binding?: WorkspaceLifecycleBinding;
}

export interface WorkspaceLifecycleObservation {
  readonly state: WorkspaceLifecycleState;
  readonly revision: number;
  readonly binding?: WorkspaceLifecycleBinding;
}

export type WorkspaceLifecycleResumeDisposition =
  | "blocked"
  | "pending"
  | "same-binding"
  | "activated"
  | "requires-open"
  | "recovery-required"
  | "closed";

export interface WorkspaceLifecycleNotAdmittedResult {
  readonly status: "not-admitted";
  readonly reasonCode: string;
  readonly snapshot: WorkspaceLifecycleSnapshot;
  readonly resume: "blocked";
}

export interface WorkspaceLifecyclePendingResult {
  readonly status: "pending";
  readonly snapshot: WorkspaceLifecycleSnapshot;
  readonly resume: "pending";
}

export interface WorkspaceLifecycleUnchangedResult {
  readonly status: "unchanged";
  readonly binding: WorkspaceLifecycleBinding;
  readonly operationOutcome: WorkspaceLifecycleOperationOutcome;
  readonly contentEffect: WorkspaceLifecycleContentEffect;
  readonly snapshot: WorkspaceLifecycleSnapshot;
  /** A stale result is retained for diagnostics but cannot resume a binding. */
  readonly resume: "blocked" | "same-binding";
}

export interface WorkspaceLifecycleActivatedResult {
  readonly status: "activated";
  readonly activation: WorkspaceLifecycleActivation;
  readonly operationOutcome: WorkspaceLifecycleOperationOutcome;
  readonly contentEffect: WorkspaceLifecycleContentEffect;
  readonly binding?: WorkspaceLifecycleBinding;
  readonly snapshot: WorkspaceLifecycleSnapshot;
  readonly resume: "blocked" | "activated" | "requires-open";
}

export interface WorkspaceLifecycleRestoredResult {
  readonly status: "restored";
  readonly activation: WorkspaceLifecycleActivation;
  readonly operationOutcome: WorkspaceLifecycleOperationOutcome;
  readonly contentEffect: WorkspaceLifecycleContentEffect;
  readonly binding?: WorkspaceLifecycleBinding;
  readonly snapshot: WorkspaceLifecycleSnapshot;
  readonly resume: "blocked" | "activated" | "requires-open";
}

export interface WorkspaceLifecycleRecoveryRequiredResult {
  readonly status: "recovery-required";
  readonly reasonCode: string;
  readonly snapshot: WorkspaceLifecycleSnapshot;
  readonly resume: "recovery-required";
}

export interface WorkspaceLifecycleClosedResult {
  readonly status: "closed";
  readonly snapshot: WorkspaceLifecycleSnapshot;
  readonly resume: "closed";
}

export type WorkspaceLifecycleResult =
  | WorkspaceLifecycleNotAdmittedResult
  | WorkspaceLifecyclePendingResult
  | WorkspaceLifecycleUnchangedResult
  | WorkspaceLifecycleActivatedResult
  | WorkspaceLifecycleRestoredResult
  | WorkspaceLifecycleRecoveryRequiredResult
  | WorkspaceLifecycleClosedResult;

type LifecycleRecord = Record<string, unknown>;

const STATES: readonly WorkspaceLifecycleState[] = [
  "no-workspace",
  "ready",
  "transition",
  "recovery-required",
  "closed",
];

const TRANSITION_PHASES: readonly WorkspaceLifecycleTransitionPhase[] = [
  "draining",
  "replacing",
  "recovering",
  "finishing",
];

const ACTIVATIONS: readonly WorkspaceLifecycleActivation[] = [
  "ready",
  "requires-open",
];

const OPERATION_OUTCOMES: readonly WorkspaceLifecycleOperationOutcome[] = [
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
];

const CONTENT_EFFECTS: readonly WorkspaceLifecycleContentEffect[] = [
  "none",
  "retained",
  "replaced",
];

const STATUSES: readonly WorkspaceLifecycleStatus[] = [
  "not-admitted",
  "pending",
  "unchanged",
  "activated",
  "restored",
  "recovery-required",
  "closed",
];

const MAX_REASON_CODE_LENGTH = 64;
const MAX_ID_LENGTH = 256;

function isRecord(value: unknown): value is LifecycleRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new Error(`invalid workspace lifecycle result at ${path}: ${message}`);
}

function parseInput(value: string | unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail("$", "expected valid JSON");
  }
}

function exactKeys(
  record: LifecycleRecord,
  allowed: readonly string[],
  path: string,
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!accepted.has(key)) fail(`${path}.${key}`, "unknown field");
  }
}

function requireRecord(value: unknown, path: string): LifecycleRecord {
  if (!isRecord(value)) fail(path, "expected an object");
  return value;
}

function requireString(
  value: unknown,
  path: string,
  { bounded = true }: { bounded?: boolean } = {},
): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "expected a non-empty string");
  }
  if (value.trim() !== value)
    fail(path, "must not contain surrounding whitespace");
  if (bounded && value.length > MAX_ID_LENGTH) {
    fail(path, `must be at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function requireReasonCode(value: unknown, path: string): string {
  const reason = requireString(value, path);
  if (
    reason.length > MAX_REASON_CODE_LENGTH ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reason)
  ) {
    fail(path, "expected a lowercase reason code");
  }
  return reason;
}

function requireRevision(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "expected a non-negative safe integer");
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(path, `expected one of ${values.join(", ")}`);
  }
  return value as T;
}

function parseBinding(value: unknown, path: string): WorkspaceLifecycleBinding {
  const record = requireRecord(value, path);
  exactKeys(record, ["workspaceId", "authorityId", "generation"], path);
  return {
    workspaceId: requireString(record.workspaceId, `${path}.workspaceId`),
    authorityId: requireString(record.authorityId, `${path}.authorityId`),
    generation: requireRevision(record.generation, `${path}.generation`),
  };
}

function sameBinding(
  left: WorkspaceLifecycleBinding | undefined,
  right: WorkspaceLifecycleBinding | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.workspaceId === right.workspaceId &&
    left.authorityId === right.authorityId &&
    left.generation === right.generation
  );
}

function parseSnapshot(
  value: unknown,
  { allowRedactedReady = false }: { allowRedactedReady?: boolean } = {},
): WorkspaceLifecycleSnapshot {
  const record = requireRecord(value, "$.snapshot");
  exactKeys(record, ["state", "revision", "phase", "binding"], "$.snapshot");
  const state = requireEnum(record.state, STATES, "$.snapshot.state");
  const revision = requireRevision(record.revision, "$.snapshot.revision");
  const phase =
    record.phase === undefined
      ? undefined
      : requireEnum(record.phase, TRANSITION_PHASES, "$.snapshot.phase");
  const binding =
    record.binding === undefined
      ? undefined
      : parseBinding(record.binding, "$.snapshot.binding");

  if (state === "transition" && phase === undefined) {
    fail("$.snapshot.phase", "is required for transition state");
  }
  if (state !== "transition" && phase !== undefined) {
    fail("$.snapshot.phase", "is only valid for transition state");
  }
  if (state === "ready" && binding === undefined && !allowRedactedReady) {
    fail("$.snapshot.binding", "is required for ready state");
  }
  if (state !== "ready" && binding !== undefined) {
    fail("$.snapshot.binding", "is only valid for ready state");
  }

  return {
    state,
    revision,
    ...(phase === undefined ? {} : { phase }),
    ...(binding === undefined ? {} : { binding }),
  };
}

function staleAgainst(
  snapshot: WorkspaceLifecycleSnapshot,
  observed: WorkspaceLifecycleObservation | undefined,
): boolean {
  if (observed === undefined) return false;
  if (observed.revision > snapshot.revision) return true;
  if (observed.revision < snapshot.revision) return false;
  if (observed.state !== snapshot.state) return true;
  return (
    snapshot.state === "ready" &&
    !sameBinding(snapshot.binding, observed.binding)
  );
}

function parseResult(value: unknown): {
  status: WorkspaceLifecycleStatus;
  reasonCode?: string;
  activation?: WorkspaceLifecycleActivation;
  operationOutcome?: WorkspaceLifecycleOperationOutcome;
  contentEffect?: WorkspaceLifecycleContentEffect;
  binding?: WorkspaceLifecycleBinding;
  snapshot: WorkspaceLifecycleSnapshot;
} {
  const record = requireRecord(value, "$");
  if (typeof record.status !== "string") fail("$.status", "is required");
  const status = requireEnum(record.status, STATUSES, "$.status");

  switch (status) {
    case "not-admitted": {
      exactKeys(record, ["status", "reasonCode", "snapshot"], "$");
      return {
        status,
        reasonCode: requireReasonCode(record.reasonCode, "$.reasonCode"),
        // A rejected request may observe an already-running owner without
        // receiving a renderer-safe authority identity.  The snapshot still
        // carries the state/revision, but it never grants resume permission.
        snapshot: parseSnapshot(record.snapshot, { allowRedactedReady: true }),
      };
    }
    case "pending": {
      exactKeys(record, ["status", "snapshot"], "$");
      return { status, snapshot: parseSnapshot(record.snapshot) };
    }
    case "unchanged": {
      exactKeys(
        record,
        ["status", "binding", "operationOutcome", "contentEffect", "snapshot"],
        "$",
      );
      const snapshot = parseSnapshot(record.snapshot);
      const binding = parseBinding(record.binding, "$.binding");
      const operationOutcome = requireEnum(
        record.operationOutcome,
        OPERATION_OUTCOMES,
        "$.operationOutcome",
      );
      const contentEffect = requireEnum(
        record.contentEffect,
        CONTENT_EFFECTS,
        "$.contentEffect",
      );
      if (
        snapshot.state !== "ready" ||
        !sameBinding(snapshot.binding, binding)
      ) {
        fail("$.binding", "must match a ready snapshot binding");
      }
      return { status, binding, operationOutcome, contentEffect, snapshot };
    }
    case "activated":
    case "restored": {
      exactKeys(
        record,
        [
          "status",
          "activation",
          "operationOutcome",
          "contentEffect",
          "binding",
          "snapshot",
        ],
        "$",
      );
      const snapshot = parseSnapshot(record.snapshot);
      const activation = requireEnum(
        record.activation,
        ACTIVATIONS,
        "$.activation",
      );
      const operationOutcome = requireEnum(
        record.operationOutcome,
        OPERATION_OUTCOMES,
        "$.operationOutcome",
      );
      const contentEffect = requireEnum(
        record.contentEffect,
        CONTENT_EFFECTS,
        "$.contentEffect",
      );
      const binding =
        record.binding === undefined
          ? undefined
          : parseBinding(record.binding, "$.binding");
      if (activation === "ready") {
        if (binding === undefined)
          fail("$.binding", "is required for ready activation");
        if (
          snapshot.state !== "ready" ||
          !sameBinding(snapshot.binding, binding)
        ) {
          fail("$.binding", "must match a ready snapshot binding");
        }
      } else {
        if (binding !== undefined) {
          fail(
            "$.binding",
            "must be omitted when activation requires an explicit open",
          );
        }
        if (
          snapshot.state !== "recovery-required" &&
          snapshot.state !== "no-workspace"
        ) {
          fail(
            "$.activation",
            "requires a recovery-required or no-workspace snapshot",
          );
        }
      }
      return {
        status,
        activation,
        operationOutcome,
        contentEffect,
        ...(binding === undefined ? {} : { binding }),
        snapshot,
      };
    }
    case "recovery-required": {
      exactKeys(record, ["status", "reasonCode", "snapshot"], "$");
      const snapshot = parseSnapshot(record.snapshot);
      if (snapshot.state !== "recovery-required") {
        fail("$.snapshot.state", "must be recovery-required");
      }
      return {
        status,
        reasonCode: requireReasonCode(record.reasonCode, "$.reasonCode"),
        snapshot,
      };
    }
    case "closed": {
      exactKeys(record, ["status", "snapshot"], "$");
      const snapshot = parseSnapshot(record.snapshot);
      if (snapshot.state !== "closed")
        fail("$.snapshot.state", "must be closed");
      return { status, snapshot };
    }
  }
}

/**
 * Parse and normalize a Native lifecycle result.  `observed` is the latest
 * main-owned snapshot, when available; it prevents an old Unchanged response
 * from reviving a binding after another operation advanced the lifecycle.
 */
export function normalizeWorkspaceLifecycleResult(
  value: string | unknown,
  observed?: WorkspaceLifecycleObservation,
): WorkspaceLifecycleResult {
  const parsed = parseResult(parseInput(value));
  const stale = staleAgainst(parsed.snapshot, observed);

  switch (parsed.status) {
    case "not-admitted":
      return {
        status: parsed.status,
        reasonCode: parsed.reasonCode as string,
        snapshot: parsed.snapshot,
        resume: "blocked",
      };
    case "pending":
      return {
        status: parsed.status,
        snapshot: parsed.snapshot,
        resume: "pending",
      };
    case "unchanged":
      return {
        status: parsed.status,
        binding: parsed.binding as WorkspaceLifecycleBinding,
        operationOutcome:
          parsed.operationOutcome as WorkspaceLifecycleOperationOutcome,
        contentEffect: parsed.contentEffect as WorkspaceLifecycleContentEffect,
        snapshot: parsed.snapshot,
        resume: stale ? "blocked" : "same-binding",
      };
    case "activated":
    case "restored": {
      const activation = parsed.activation as WorkspaceLifecycleActivation;
      const resume = stale
        ? "blocked"
        : activation === "ready"
          ? "activated"
          : "requires-open";
      return {
        status: parsed.status,
        activation,
        operationOutcome: parsed.operationOutcome as WorkspaceLifecycleOperationOutcome,
        contentEffect: parsed.contentEffect as WorkspaceLifecycleContentEffect,
        ...(parsed.binding === undefined ? {} : { binding: parsed.binding }),
        snapshot: parsed.snapshot,
        resume,
      };
    }
    case "recovery-required":
      return {
        status: parsed.status,
        reasonCode: parsed.reasonCode as string,
        snapshot: parsed.snapshot,
        resume: "recovery-required",
      };
    case "closed":
      return {
        status: parsed.status,
        snapshot: parsed.snapshot,
        resume: "closed",
      };
  }
}
