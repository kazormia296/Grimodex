import { listen } from "@/lib/tauri";
import { setCurrentImeWorkspaceIdentity } from "@/features/ime/workspaceScope";
import { invalidateWorkspaceProjectLoads } from "@/application/project/workspaceProjectCommands";
import { invalidateWorkspaceBindingForLifecycle } from "@/features/timelapse/recorder";
import type { RecoveryShellState } from "./recovery/types";
import type { WorkspaceState } from "./workspaceState";

export type WorkspaceLifecycleProjectionStatus =
  | "ready"
  | "transition"
  | "recovery-required"
  | "closed";
export type WorkspaceLifecycleProjectionActivation =
  | "ready"
  | "requires-open"
  | "none";

export interface WorkspaceLifecycleProjection {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly status: WorkspaceLifecycleProjectionStatus;
  readonly bindingToken: string | null;
  readonly activation: WorkspaceLifecycleProjectionActivation;
}

type WorkspaceGetter = () => WorkspaceState;
type WorkspaceSetter = (patch: Partial<WorkspaceState>) => void;

let subscription: Promise<() => void> | null = null;
let latestRevision = -1;
let latestWire: string | null = null;

function parseProjection(raw: unknown): WorkspaceLifecycleProjection {
  let value = raw;
  if (typeof raw === "string") value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace lifecycle projection must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "activation",
    "bindingToken",
    "revision",
    "schemaVersion",
    "status",
  ];
  const keys = Object.keys(record).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error("workspace lifecycle projection has unknown fields");
  }
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 0
  ) {
    throw new Error("workspace lifecycle projection has invalid revision");
  }
  const status = record.status;
  const activation = record.activation;
  if (
    status !== "ready" &&
    status !== "transition" &&
    status !== "recovery-required" &&
    status !== "closed"
  ) {
    throw new Error("workspace lifecycle projection has invalid status");
  }
  if (
    activation !== "ready" &&
    activation !== "requires-open" &&
    activation !== "none"
  ) {
    throw new Error("workspace lifecycle projection has invalid activation");
  }
  const token = record.bindingToken;
  if (token !== null && (typeof token !== "string" || token.trim() === "")) {
    throw new Error("workspace lifecycle projection has invalid binding token");
  }
  if (
    (status === "ready" && (activation !== "ready" || token === null)) ||
    (status === "transition" && (activation !== "none" || token === null)) ||
    (status === "recovery-required" &&
      (activation !== "requires-open" || token === null)) ||
    (status === "closed" && (activation !== "none" || token !== null))
  ) {
    throw new Error(
      "workspace lifecycle projection has an invalid combination",
    );
  }
  return {
    schemaVersion: 1,
    revision: record.revision as number,
    status,
    bindingToken: token as string | null,
    activation,
  };
}

function applyProjection(
  get: WorkspaceGetter,
  set: WorkspaceSetter,
  raw: unknown,
): void {
  let view: WorkspaceLifecycleProjection;
  try {
    view = parseProjection(raw);
  } catch {
    return;
  }
  const wire = JSON.stringify(view);
  if (view.revision < latestRevision) return;
  // Re-delivery of the exact same snapshot is an idempotent observation.  In
  // particular, do not run RecoveryRequired teardown twice: the first pass
  // intentionally clears activeWorkspacePath after copying the binding into
  // RecoveryShell, and a second pass must retain that shell and retry target.
  if (view.revision === latestRevision && latestWire === wire) return;
  if (
    view.revision === latestRevision &&
    latestWire !== null &&
    wire !== latestWire
  ) {
    return;
  }
  latestRevision = view.revision;
  latestWire = wire;
  const current = get();
  const base = {
    workspaceLifecycleRevision: view.revision,
    workspaceLifecycleStatus: view.status,
    workspaceLifecycleActivation: view.activation,
    workspaceLifecycleBindingToken: view.bindingToken,
  } satisfies Partial<WorkspaceState>;

  if (view.status === "ready" && view.activation === "ready") {
    set(base);
    return;
  }

  // Transition and recovery both invalidate the old renderer scope. This is
  // deliberately a local teardown: it never flushes an isolated connection,
  // guesses a path from Native, or resumes a binding from a rejected request.
  invalidateWorkspaceBindingForLifecycle();
  invalidateWorkspaceProjectLoads();
  setCurrentImeWorkspaceIdentity(null);
  if (view.status === "recovery-required") {
    // The first recovery projection moves the path into RecoveryShell while
    // invalidating the active binding.  A repeated snapshot for the same
    // revision must reuse that already-known path instead of turning the
    // shell into a launcher with no retry target.
    const workspacePath =
      current.activeWorkspacePath ?? current.recoveryShell?.workspacePath;
    const recovery: RecoveryShellState | null = workspacePath
      ? {
          mode: "recovery-required",
          workspacePath,
          reason:
            "Native lifecycle recovery is required before the workspace can be reopened.",
          candidates: current.recoveryShell?.candidates ?? [],
        }
      : null;
    set({
      ...base,
      view: recovery ? "recovery" : "launcher",
      workspaceSwitchInProgress: false,
      workspaceHydrated: false,
      activeWorkspacePath: null,
      activeWorkspaceId: null,
      activeWorkspaceName: null,
      recoveryShell: recovery,
    });
    return;
  }
  set({
    ...base,
    workspaceSwitchInProgress: view.status === "transition",
    workspaceHydrated: false,
    ...(view.status === "closed"
      ? {
          view: "launcher" as const,
          activeWorkspacePath: null,
          activeWorkspaceId: null,
        }
      : {}),
  });
}

/** Subscribe once per renderer realm; StrictMode callers share the promise. */
export function subscribeWorkspaceLifecycleProjection(
  get: WorkspaceGetter,
  set: WorkspaceSetter,
): Promise<() => void> {
  if (subscription) return subscription;
  subscription = listen<unknown>("workspace:lifecycle-state", (payload) => {
    applyProjection(get, set, payload);
  }).catch((error) => {
    subscription = null;
    throw error;
  });
  return subscription;
}

export function applyWorkspaceLifecycleProjectionForTest(
  get: WorkspaceGetter,
  set: WorkspaceSetter,
  raw: unknown,
): void {
  applyProjection(get, set, raw);
}
