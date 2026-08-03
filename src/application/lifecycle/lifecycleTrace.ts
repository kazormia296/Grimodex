export const LIFECYCLE_TRACE_OPT_IN_KEY =
  "__GRIMODEX_PRODUCT_JOURNEY_LIFECYCLE_TRACE__" as const;

export const LIFECYCLE_TRACE_EVENT_NAME = "grimodex:lifecycle-trace" as const;

export const LIFECYCLE_TRANSITION_PHASES = [
  "switch-requested",
  "quiescence-started",
  "old-stream-completed",
  "old-scope-persisted",
  "authority-commit",
  "new-scope-hydrated",
] as const;

export type LifecycleTransitionPhase =
  (typeof LIFECYCLE_TRANSITION_PHASES)[number];

export type LifecycleTransitionKind = "project" | "workspace";

export interface LifecycleScopeIdentity {
  readonly workspacePath: string | null;
  readonly workspaceOpenRevision: number | null;
  readonly projectId: string | null;
}

export interface LifecycleTransitionInput {
  readonly kind: LifecycleTransitionKind;
  readonly from: LifecycleScopeIdentity;
  readonly to: LifecycleScopeIdentity;
}

export interface LifecycleTraceEvent {
  readonly schemaVersion: 1;
  readonly transitionId: string;
  readonly sequence: number;
  readonly timestampMs: number;
  readonly kind: LifecycleTransitionKind;
  readonly phase: LifecycleTransitionPhase;
  readonly from: LifecycleScopeIdentity;
  readonly to: LifecycleScopeIdentity;
}

export interface LifecycleTransitionTrace {
  readonly transitionId: string;
  /**
   * Records the actual milestone order. Missing or out-of-order phases remain
   * visible to the journey assertion; only duplicate phase emissions are
   * suppressed.
   */
  advance: (
    phase: Exclude<LifecycleTransitionPhase, "switch-requested">,
  ) => boolean;
  /** Fill target identity fields that are only known after native open/read. */
  updateTarget: (target: Partial<LifecycleScopeIdentity>) => void;
}

type LifecycleTraceListener = (event: LifecycleTraceEvent) => void;

const listeners = new Set<LifecycleTraceListener>();
const activeTransitions: LifecycleTransitionTrace[] = [];
let fallbackTransitionSequence = 0;

export function isLifecycleTraceEnabled(): boolean {
  return (
    (globalThis as typeof globalThis & Record<string, unknown>)[
      LIFECYCLE_TRACE_OPT_IN_KEY
    ] === true
  );
}

function nextTransitionId(kind: LifecycleTransitionKind): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${kind}:${uuid}`;
  fallbackTransitionSequence += 1;
  return `${kind}:${Date.now().toString(36)}:${fallbackTransitionSequence}`;
}

function immutableScope(scope: LifecycleScopeIdentity): LifecycleScopeIdentity {
  return Object.freeze({ ...scope });
}

function publish(event: LifecycleTraceEvent): void {
  if (!isLifecycleTraceEnabled()) return;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // Observability must never change lifecycle behavior.
    }
  }
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
    return;
  }
  try {
    window.dispatchEvent(
      new CustomEvent<LifecycleTraceEvent>(LIFECYCLE_TRACE_EVENT_NAME, {
        detail: event,
      }),
    );
  } catch {
    // Product-journey instrumentation is best-effort for the application.
  }
}

export function beginLifecycleTransition(
  input: LifecycleTransitionInput,
): LifecycleTransitionTrace {
  const transitionId = nextTransitionId(input.kind);
  const from = immutableScope(input.from);
  let to = immutableScope(input.to);
  let sequence = 0;
  const emitted = new Set<LifecycleTransitionPhase>();

  const emit = (phase: LifecycleTransitionPhase): boolean => {
    if (emitted.has(phase)) return false;
    emitted.add(phase);
    const event = Object.freeze({
      schemaVersion: 1 as const,
      transitionId,
      sequence,
      timestampMs: Date.now(),
      kind: input.kind,
      phase,
      from,
      to: immutableScope(to),
    });
    sequence += 1;
    publish(event);
    return true;
  };

  const transition: LifecycleTransitionTrace = {
    transitionId,
    advance(phase) {
      return emit(phase);
    },
    updateTarget(target) {
      to = immutableScope({ ...to, ...target });
    },
  };
  emit("switch-requested");
  return transition;
}

export function subscribeLifecycleTrace(
  listener: LifecycleTraceListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Makes asynchronous stream completion callbacks part of the strict
 * quiescence transition that is currently draining them.
 */
export function activateLifecycleTransition(
  transition: LifecycleTransitionTrace,
): () => void {
  // A lease owns the transition for its full lifetime. Strict quiescence may
  // activate the same transition again while draining; do not move an older
  // transition above a newer overlapping lifecycle in the global stack.
  if (activeTransitions.includes(transition)) return () => {};
  activeTransitions.push(transition);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = activeTransitions.lastIndexOf(transition);
    if (index >= 0) activeTransitions.splice(index, 1);
  };
}

export function advanceActiveLifecycleTransition(
  phase: Extract<
    LifecycleTransitionPhase,
    "old-stream-completed" | "old-scope-persisted"
  >,
): boolean {
  const active = activeTransitions.at(-1);
  return active?.advance(phase) ?? false;
}
