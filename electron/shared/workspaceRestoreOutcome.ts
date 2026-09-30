/**
 * Renderer-safe terminal result for the legacy restore_backup command.
 *
 * Restore used to expose Promise<void>, which forced the renderer to infer
 * whether an error happened before or after Native admission from an error
 * string.  The lifecycle proof is now explicit and operation-scoped: the
 * opaque binding token and revision are enough to authorize an exact
 * Unchanged resume without exposing a locator, authority id, or Run.
 */

export type WorkspaceRestoreOutcomeStatus =
  | "not-admitted"
  | "unchanged"
  | "activated"
  | "restored"
  | "recovery-required"
  | "closed";

export type WorkspaceRestoreOperationOutcome =
  | "succeeded"
  | "failed"
  | "unknown";

export type WorkspaceRestoreContentEffect =
  | "none"
  | "retained"
  | "replaced";

export interface WorkspaceRestoreLifecycleSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly status: "ready" | "transition" | "recovery-required" | "closed";
  readonly bindingToken: string | null;
  readonly activation: "ready" | "requires-open" | "none";
}

export interface WorkspaceRestoreOutcome {
  readonly status: WorkspaceRestoreOutcomeStatus;
  readonly operationOutcome: WorkspaceRestoreOperationOutcome;
  readonly contentEffect: WorkspaceRestoreContentEffect;
  readonly lifecycle: WorkspaceRestoreLifecycleSnapshot;
  readonly activation?: "ready" | "requires-open";
  readonly reasonCode?: string;
}

type RecordValue = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`invalid workspace restore outcome at ${path}: ${message}`);
}

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as RecordValue;
}

function exactKeys(value: RecordValue, allowed: readonly string[], path: string) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${path}.${key}`, "unknown field");
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function revision(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "expected a non-negative safe integer");
  }
  return value;
}

function lifecycle(value: unknown): WorkspaceRestoreLifecycleSnapshot {
  const item = record(value, "$.lifecycle");
  exactKeys(
    item,
    ["schemaVersion", "revision", "status", "bindingToken", "activation"],
    "$.lifecycle",
  );
  if (item.schemaVersion !== 1) fail("$.lifecycle.schemaVersion", "unsupported");
  const status = item.status;
  const activation = item.activation;
  const token = item.bindingToken;
  if (
    status !== "ready" &&
    status !== "transition" &&
    status !== "recovery-required" &&
    status !== "closed"
  ) {
    fail("$.lifecycle.status", "unknown status");
  }
  if (
    activation !== "ready" &&
    activation !== "requires-open" &&
    activation !== "none"
  ) {
    fail("$.lifecycle.activation", "unknown activation");
  }
  if (token !== null && typeof token !== "string") {
    fail("$.lifecycle.bindingToken", "expected null or string");
  }
  if (
    (status === "ready" && (activation !== "ready" || token === null)) ||
    (status === "transition" && (activation !== "none" || token === null)) ||
    (status === "recovery-required" &&
      (activation !== "requires-open" || token === null)) ||
    (status === "closed" && (activation !== "none" || token !== null))
  ) {
    fail("$.lifecycle", "invalid status/activation/binding combination");
  }
  return {
    schemaVersion: 1,
    revision: revision(item.revision, "$.lifecycle.revision"),
    status,
    bindingToken: token as string | null,
    activation,
  };
}

export function parseWorkspaceRestoreOutcome(
  value: string | unknown,
): WorkspaceRestoreOutcome {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      fail("$", "expected valid JSON");
    }
  }
  const item = record(parsed, "$");
  exactKeys(
    item,
    [
      "status",
      "operationOutcome",
      "contentEffect",
      "lifecycle",
      "activation",
      "reasonCode",
    ],
    "$",
  );
  const status = item.status;
  const operationOutcome = item.operationOutcome;
  const contentEffect = item.contentEffect;
  if (
    status !== "not-admitted" &&
    status !== "unchanged" &&
    status !== "activated" &&
    status !== "restored" &&
    status !== "recovery-required" &&
    status !== "closed"
  ) {
    fail("$.status", "unknown status");
  }
  if (
    operationOutcome !== "succeeded" &&
    operationOutcome !== "failed" &&
    operationOutcome !== "unknown"
  ) {
    fail("$.operationOutcome", "unknown operation outcome");
  }
  if (
    contentEffect !== "none" &&
    contentEffect !== "retained" &&
    contentEffect !== "replaced"
  ) {
    fail("$.contentEffect", "unknown content effect");
  }
  const snapshot = lifecycle(item.lifecycle);
  const reasonCode =
    item.reasonCode === undefined
      ? undefined
      : stringValue(item.reasonCode, "$.reasonCode");
  const activation = item.activation;
  if (activation !== undefined && activation !== "ready" && activation !== "requires-open") {
    fail("$.activation", "unknown activation");
  }
  if (status === "not-admitted" && (!reasonCode || operationOutcome === "succeeded")) {
    fail("$", "not-admitted requires a reason and failed/unknown outcome");
  }
  if (status === "not-admitted" && contentEffect !== "none") {
    fail("$.contentEffect", "not-admitted cannot change content");
  }
  if (status === "recovery-required" && !reasonCode) {
    fail("$", "recovery-required requires a reason");
  }
  if (status === "unchanged") {
    if (operationOutcome === "succeeded" || contentEffect !== "none") {
      fail("$", "unchanged requires a failed/unknown operation with no content effect");
    }
    if (snapshot.status !== "ready" || snapshot.activation !== "ready") {
      fail("$.lifecycle", "unchanged requires a ready lifecycle snapshot");
    }
    if (activation !== undefined) fail("$.activation", "must be omitted");
  }
  if (status === "activated" || status === "restored") {
    if (activation === undefined) fail("$.activation", "is required");
    if (contentEffect === "none") fail("$.contentEffect", "must describe the effect");
    if (snapshot.status !== "ready" || snapshot.activation !== "ready") {
      fail("$.lifecycle", "activated/restored requires a ready lifecycle snapshot");
    }
    if (status === "restored" &&
        (operationOutcome !== "succeeded" || contentEffect !== "replaced" || activation !== "ready")) {
      fail("$", "restored requires a successful replacement and ready activation");
    }
  } else if (activation !== undefined) {
    fail("$.activation", "is only valid for activated/restored outcomes");
  }
  if (status === "recovery-required" && snapshot.status !== "recovery-required") {
    fail("$.lifecycle", "recovery-required requires a recovery snapshot");
  }
  return {
    status,
    operationOutcome,
    contentEffect,
    lifecycle: snapshot,
    ...(activation === undefined ? {} : { activation }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  } as WorkspaceRestoreOutcome;
}
