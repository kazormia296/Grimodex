import { listen } from "@/lib/tauri";
import { setCurrentImeWorkspaceIdentity } from "@/features/ime/workspaceScope";
import { invalidateWorkspaceProjectLoads } from "@/application/project/workspaceProjectCommands";
import {
  invalidateWorkspaceBindingForLifecycle,
  pauseWorkspaceBindingForLifecycle,
  resumeWorkspaceBindingAfterExplicitOpen,
  resumeWorkspaceBindingAfterLifecycleUnchanged,
} from "@/features/timelapse/recorder";
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

interface ReadyScopeProof {
  readonly bindingToken: string;
  readonly workspacePath: string;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  readonly openRevision: number;
}

interface ExplicitWorkspaceHydrationEvidence {
  readonly workspacePath: string;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  readonly openRevision: number;
  /** Exact proof returned by the Native Open operation. */
  readonly lifecycleRevision: number;
  readonly lifecycleBindingToken: string;
  readonly phase: "pending" | "complete";
}

interface ReadyObservation {
  readonly revision: number;
  readonly bindingToken: string;
}

let subscription: Promise<() => void> | null = null;
let latestRevision = -1;
let latestWire: string | null = null;
// A later same-token Ready can be an Unchanged result after a real
// Transition. Keep its accepted invalidation boundary even after Ready
// returns, so an older Open cannot regain ownership from token equality.
let latestHydrationInvalidationRevision = -1;
let lastReadyScope: ReadyScopeProof | null = null;
let latestReadyObservation: ReadyObservation | null = null;
let pendingExplicitWorkspaceHydration: ExplicitWorkspaceHydrationEvidence | null =
  null;

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
  forceUnchangedProof = false,
): void {
  let view: WorkspaceLifecycleProjection;
  try {
    view = parseProjection(raw);
  } catch {
    return;
  }
  // Native's terminal Open proof can overtake its queued notifications.
  // None of those older observations can invalidate the pending new owner.
  if (
    pendingExplicitWorkspaceHydration?.phase === "pending" &&
    view.revision < pendingExplicitWorkspaceHydration.lifecycleRevision
  )
    return;
  const wire = JSON.stringify(view);
  if (view.revision < latestRevision) return;
  // Re-delivery of the exact same snapshot is an idempotent observation.  In
  // particular, do not run RecoveryRequired teardown twice: the first pass
  // intentionally clears activeWorkspacePath after copying the binding into
  // RecoveryShell, and a second pass must retain that shell and retry target.
  if (
    view.revision === latestRevision &&
    latestWire === wire &&
    !forceUnchangedProof
  )
    return;
  if (
    view.revision === latestRevision &&
    latestWire !== null &&
    wire !== latestWire
  ) {
    return;
  }
  if (view.status !== "ready") {
    latestHydrationInvalidationRevision = view.revision;
  } else if (
    latestReadyObservation &&
    latestReadyObservation.bindingToken !== view.bindingToken
  ) {
    // The Open result may arrive after its first Ready observation. Its
    // exact proof can establish this token before the observed revision,
    // but cannot supersede a different Ready already seen after that proof.
    latestHydrationInvalidationRevision = Math.max(
      latestHydrationInvalidationRevision,
      latestReadyObservation.revision,
    );
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
    const bindingToken = view.bindingToken;
    if (bindingToken === null) return;
    latestReadyObservation = {
      revision: view.revision,
      bindingToken,
    };
    const explicitOpenReady =
      pendingExplicitWorkspaceHydration !== null &&
      readyProofForExplicitHydration(pendingExplicitWorkspaceHydration) !==
        null;
    if (explicitOpenReady && pendingExplicitWorkspaceHydration) {
      // The Ready notification can race the Project hydration owned by this
      // Open binding, including a revision-only background recovery. Keep
      // the original proof pending and preserve the load instead of
      // invalidating it as an unrelated replacement.  The Open owner must
      // publish editor-ready only after the load returns and promotes this
      // evidence to `complete` below.
      if (pendingExplicitWorkspaceHydration.phase === "pending") {
        set(base);
        return;
      }
      // The Open proof establishes a new authority after the normal
      // recorder/project rebind.  If a Transition raced the Open, retire only
      // that reversible pause; do not route this through Unchanged, which has
      // the stronger meaning that the old authority survived.
      if (!resumeWorkspaceBindingAfterExplicitOpen()) {
        invalidateWorkspaceBindingForLifecycle();
        invalidateWorkspaceProjectLoads();
        pendingExplicitWorkspaceHydration = null;
        set({
          ...base,
          view: "launcher",
          workspaceSwitchInProgress: false,
          workspaceHydrated: false,
          activeWorkspacePath: null,
          activeWorkspaceId: null,
          activeWorkspaceName: null,
          recoveryShell: null,
        });
        return;
      }
      // An explicit Open is the renderer-side evidence that the new Native
      // authority has already been hydrated.  Accept a Ready event that was
      // delivered after that hydration even when the non-blocking Native
      // event raced the Open Promise.  The path and renderer open revision
      // bind this proof to this Open; the lifecycle revision prevents an old
      // Ready snapshot from being adopted as the new authority.
      set({
        ...base,
        view: "editor",
        workspaceSwitchInProgress: false,
        workspaceHydrated: true,
        activeWorkspacePath: pendingExplicitWorkspaceHydration.workspacePath,
        activeWorkspaceId: pendingExplicitWorkspaceHydration.workspaceId,
        activeWorkspaceName: pendingExplicitWorkspaceHydration.workspaceName,
        recoveryShell: null,
      });
      lastReadyScope = {
        bindingToken,
        workspacePath: pendingExplicitWorkspaceHydration.workspacePath,
        workspaceId: pendingExplicitWorkspaceHydration.workspaceId,
        workspaceName: pendingExplicitWorkspaceHydration.workspaceName,
        openRevision: pendingExplicitWorkspaceHydration.openRevision,
      };
      pendingExplicitWorkspaceHydration = null;
      return;
    }
    const unchangedResume =
      (forceUnchangedProof ||
        current.workspaceLifecycleStatus === "transition") &&
      view.bindingToken !== null &&
      lastReadyScope?.bindingToken === view.bindingToken &&
      current.activeWorkspacePath === lastReadyScope.workspacePath &&
      current.workspaceOpenRevision === lastReadyScope.openRevision &&
      (forceUnchangedProof || current.workspaceHydrated === false);
    const sameReadyBinding =
      current.workspaceLifecycleStatus === "ready" &&
      current.workspaceLifecycleActivation === "ready" &&
      current.workspaceLifecycleBindingToken === bindingToken &&
      current.workspaceHydrated;
    if (unchangedResume && lastReadyScope) {
      // The Native core has proved Unchanged for the exact old LiveBinding.
      // Re-enable the existing renderer scope only from that proof; an
      // ordinary Ready event with a new token still requires the normal open
      // hydration path.
      const resumed = resumeWorkspaceBindingAfterLifecycleUnchanged();
      if (!resumed) return;
      set({
        ...base,
        view: "editor",
        activeWorkspacePath: lastReadyScope.workspacePath,
        activeWorkspaceId: lastReadyScope.workspaceId,
        activeWorkspaceName: lastReadyScope.workspaceName,
        workspaceSwitchInProgress: false,
        workspaceHydrated: true,
        recoveryShell: null,
      });
      setCurrentImeWorkspaceIdentity({
        path: lastReadyScope.workspacePath,
        openRevision: lastReadyScope.openRevision,
      });
    } else if (sameReadyBinding) {
      // A revision-only snapshot (for example, an unrelated descriptor
      // recovery while this workspace remains Ready) must not tear down the
      // live renderer scope. The opaque binding token is the proof that this
      // snapshot describes the same authority.
      set(base);
      lastReadyScope = {
        bindingToken,
        workspacePath: current.activeWorkspacePath!,
        workspaceId: current.activeWorkspaceId,
        workspaceName: current.activeWorkspaceName,
        openRevision: current.workspaceOpenRevision,
      };
      return;
    } else {
      // A different Ready binding is a real replacement. Discard the paused
      // old-scope queue and force the normal project/recorder hydration path
      // before the renderer can claim the new scope.
      invalidateWorkspaceBindingForLifecycle();
      invalidateWorkspaceProjectLoads();
      lastReadyScope = null;
      pendingExplicitWorkspaceHydration = null;
      set({
        ...base,
        view: "launcher",
        workspaceSwitchInProgress: false,
        workspaceHydrated: false,
        activeWorkspacePath: null,
        activeWorkspaceId: null,
        activeWorkspaceName: null,
        recoveryShell: null,
      });
    }
    const readyScope =
      unchangedResume && lastReadyScope
        ? lastReadyScope
        : current.activeWorkspacePath
          ? {
              bindingToken: view.bindingToken ?? "",
              workspacePath: current.activeWorkspacePath,
              workspaceId: current.activeWorkspaceId,
              workspaceName: current.activeWorkspaceName,
              openRevision: current.workspaceOpenRevision,
            }
          : null;
    lastReadyScope = readyScope;
    return;
  }

  // Transition is a reversible pause. Only a later exact Unchanged proof may
  // resume this scope; RecoveryRequired and a replacement Ready event use the
  // irreversible invalidation below.
  if (view.status === "transition") {
    if (
      pendingExplicitWorkspaceHydration &&
      view.revision > pendingExplicitWorkspaceHydration.lifecycleRevision
    )
      pendingExplicitWorkspaceHydration = null;
    if (
      current.workspaceLifecycleStatus === "ready" &&
      current.workspaceLifecycleBindingToken &&
      current.activeWorkspacePath &&
      current.workspaceHydrated
    ) {
      lastReadyScope = {
        bindingToken: current.workspaceLifecycleBindingToken,
        workspacePath: current.activeWorkspacePath,
        workspaceId: current.activeWorkspaceId,
        workspaceName: current.activeWorkspaceName,
        openRevision: current.workspaceOpenRevision,
      };
    }
    pauseWorkspaceBindingForLifecycle();
  } else {
    pendingExplicitWorkspaceHydration = null;
    invalidateWorkspaceBindingForLifecycle();
    invalidateWorkspaceProjectLoads();
  }
  if (view.status !== "transition") setCurrentImeWorkspaceIdentity(null);
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
  if (view.status === "closed") lastReadyScope = null;
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

/**
 * Apply an operation-scoped exact Unchanged proof through the same projection
 * machine used by Native lifecycle events. This handles both callback orders:
 * a Ready proof may arrive after Transition, or it may arrive before a stale
 * Transition event. The revision gate makes the latter event inert.
 */
export function applyWorkspaceLifecycleUnchangedProof(
  get: WorkspaceGetter,
  set: WorkspaceSetter,
  raw: unknown,
): boolean {
  let view: WorkspaceLifecycleProjection;
  try {
    view = parseProjection(raw);
  } catch {
    return false;
  }
  if (
    view.status !== "ready" ||
    view.activation !== "ready" ||
    view.bindingToken === null ||
    latestRevision > view.revision
  ) {
    return false;
  }
  applyProjection(get, set, view, true);
  const current = get();
  return (
    current.workspaceLifecycleRevision === view.revision &&
    current.workspaceLifecycleStatus === "ready" &&
    current.workspaceLifecycleActivation === "ready" &&
    current.workspaceLifecycleBindingToken === view.bindingToken &&
    current.workspaceHydrated
  );
}

/**
 * Derive publication evidence from the fixed Native Open proof and accepted
 * lifecycle history. A background recovery can advance Ready while retaining
 * the live binding; a later accepted invalidation makes that Open obsolete.
 */
function readyProofForExplicitHydration(
  evidence: Omit<ExplicitWorkspaceHydrationEvidence, "phase">,
): WorkspaceLifecycleProjection | null {
  if (latestRevision >= evidence.lifecycleRevision) {
    if (
      latestHydrationInvalidationRevision > evidence.lifecycleRevision ||
      latestReadyObservation?.revision !== latestRevision ||
      latestReadyObservation.bindingToken !== evidence.lifecycleBindingToken
    )
      return null;
  }
  return {
    schemaVersion: 1,
    revision: Math.max(latestRevision, evidence.lifecycleRevision),
    status: "ready",
    activation: "ready",
    bindingToken: evidence.lifecycleBindingToken,
  };
}

/** The current Ready used at commit; this does not rewrite the Open proof. */
export function resolveExplicitWorkspaceHydrationReadyProof(
  evidence: Omit<ExplicitWorkspaceHydrationEvidence, "phase">,
): WorkspaceLifecycleProjection | null {
  if (!isExplicitWorkspaceHydrationCurrent(evidence)) return null;
  return readyProofForExplicitHydration(evidence);
}

/**
 * Record the renderer evidence for a successful explicit Open.  Native emits
 * lifecycle state through a non-blocking callback, so the Ready observation
 * may arrive either before or after the Open Promise resolves.  Keep the
 * evidence until its continuous Ready binding is observed, and only bind it
 * to the original proof returned by this Open after it crossed Native.
 */
export function noteExplicitWorkspaceHydration(
  evidence: Omit<ExplicitWorkspaceHydrationEvidence, "phase">,
): void {
  const ready = readyProofForExplicitHydration(evidence);
  if (!ready) return;
  // Completing a superseded owner must not overwrite another Open's proof.
  if (
    pendingExplicitWorkspaceHydration &&
    !matchesExplicitHydrationEvidence(
      pendingExplicitWorkspaceHydration,
      evidence,
    )
  )
    return;
  pendingExplicitWorkspaceHydration = { ...evidence, phase: "complete" };
  if (latestReadyObservation?.revision === ready.revision) {
    if (!resumeWorkspaceBindingAfterExplicitOpen()) return;
    lastReadyScope = {
      bindingToken: evidence.lifecycleBindingToken,
      workspacePath: evidence.workspacePath,
      workspaceId: evidence.workspaceId,
      workspaceName: evidence.workspaceName,
      openRevision: evidence.openRevision,
    };
    pendingExplicitWorkspaceHydration = null;
  }
}

/** Register the exact Native Open before its asynchronous Project hydration. */
export function beginExplicitWorkspaceHydration(
  evidence: Omit<ExplicitWorkspaceHydrationEvidence, "phase">,
): void {
  pendingExplicitWorkspaceHydration = { ...evidence, phase: "pending" };
}

function matchesExplicitHydrationEvidence(
  pending: ExplicitWorkspaceHydrationEvidence,
  evidence: Omit<ExplicitWorkspaceHydrationEvidence, "phase">,
): boolean {
  return (
    pending.workspacePath === evidence.workspacePath &&
    pending.workspaceId === evidence.workspaceId &&
    pending.workspaceName === evidence.workspaceName &&
    pending.openRevision === evidence.openRevision &&
    pending.lifecycleRevision === evidence.lifecycleRevision &&
    pending.lifecycleBindingToken === evidence.lifecycleBindingToken
  );
}

/**
 * Check that the Open-owned hydration was not invalidated by a newer lifecycle
 * binding while its Project load was awaiting I/O.  A stale load resolves
 * normally after generation invalidation, so the owner needs this explicit
 * proof before publishing a successful Open result.
 */
export function isExplicitWorkspaceHydrationCurrent(
  evidence: Omit<ExplicitWorkspaceHydrationEvidence, "phase">,
): boolean {
  const pending = pendingExplicitWorkspaceHydration;
  return (
    pending !== null &&
    pending.phase === "pending" &&
    matchesExplicitHydrationEvidence(pending, evidence) &&
    readyProofForExplicitHydration(evidence) !== null
  );
}

/** Drop an Open proof when the owned hydration fails or is superseded. */
export function cancelExplicitWorkspaceHydration(): void {
  if (pendingExplicitWorkspaceHydration?.phase === "pending") {
    pendingExplicitWorkspaceHydration = null;
  }
}

export function resetWorkspaceLifecycleProjectionForTest(): void {
  latestRevision = -1;
  latestWire = null;
  latestHydrationInvalidationRevision = -1;
  lastReadyScope = null;
  latestReadyObservation = null;
  pendingExplicitWorkspaceHydration = null;
}
