/** Strict main-side parser for the renderer-safe Native lifecycle snapshot. */

export type WorkspaceLifecycleViewStatus =
  | "ready"
  | "transition"
  | "recovery-required"
  | "closed";

export type WorkspaceLifecycleViewActivation =
  | "ready"
  | "requires-open"
  | "none";

export interface WorkspaceLifecycleView {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly status: WorkspaceLifecycleViewStatus;
  readonly bindingToken: string | null;
  readonly activation: WorkspaceLifecycleViewActivation;
}

function invalid(message: string): never {
  throw new Error(`invalid workspace lifecycle view: ${message}`);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("expected an object");
  }
  return value as Record<string, unknown>;
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid("revision must be a non-negative safe integer");
  }
  return value as number;
}

function requireBindingToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    value.includes("\u0000")
  ) {
    invalid("bindingToken must be a non-empty opaque string");
  }
  return value;
}

/** Parse Native JSON or an already decoded event payload. */
export function parseWorkspaceLifecycleView(
  raw: unknown,
): WorkspaceLifecycleView {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      invalid("payload is not valid JSON");
    }
  }
  const record = requireRecord(value);
  const keys = Object.keys(record).sort();
  const expected = [
    "activation",
    "bindingToken",
    "revision",
    "schemaVersion",
    "status",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    invalid("unknown or missing fields");
  }
  if (record.schemaVersion !== 1) invalid("unsupported schemaVersion");
  const revision = requireRevision(record.revision);
  if (
    record.status !== "ready" &&
    record.status !== "transition" &&
    record.status !== "recovery-required" &&
    record.status !== "closed"
  ) {
    invalid("unknown status");
  }
  if (
    record.activation !== "ready" &&
    record.activation !== "requires-open" &&
    record.activation !== "none"
  ) {
    invalid("unknown activation");
  }
  const status = record.status as WorkspaceLifecycleViewStatus;
  const activation = record.activation as WorkspaceLifecycleViewActivation;
  const bindingToken =
    record.bindingToken === null
      ? null
      : requireBindingToken(record.bindingToken);
  if (status === "ready" && (activation !== "ready" || bindingToken === null)) {
    invalid("ready requires activation=ready and a binding token");
  }
  if (
    status === "transition" &&
    (activation !== "none" || bindingToken === null)
  ) {
    invalid("transition requires activation=none and a binding token");
  }
  if (
    status === "recovery-required" &&
    (activation !== "requires-open" || bindingToken === null)
  ) {
    invalid(
      "recovery-required requires activation=requires-open and a binding token",
    );
  }
  if (status === "closed" && (activation !== "none" || bindingToken !== null)) {
    invalid("closed requires activation=none and no binding token");
  }
  return {
    schemaVersion: 1,
    revision,
    status,
    bindingToken,
    activation,
  };
}
