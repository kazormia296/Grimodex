export type TurnSurface = "chat" | "agent";

export type TurnTransport = "http" | "cli-exec" | "codex-app-server";

export type TurnPhase =
  | "preparing"
  | "streaming"
  | "agent-running"
  | "persisting"
  | "completed"
  | "aborted"
  | "failed";

export interface TurnWorkspaceAuthority {
  path: string;
  openRevision: number;
}

/**
 * Immutable identity captured before the first turn-owned await.
 *
 * A request is deliberately transport-agnostic: the route key identifies the
 * destination and budget chosen by the caller, while the coordinator owns
 * only lifecycle and stale-turn exclusion.
 */
export interface TurnRequest {
  readonly requestId: string;
  readonly workspace: TurnWorkspaceAuthority | null;
  readonly projectId: string;
  readonly sceneId: string | null;
  readonly sessionId: string | null;
  readonly scope: string;
  readonly scopeAnchorId: string | null;
  readonly routeAuthorityKey: string | null;
}

export interface TurnControl {
  readonly id: string;
  readonly request: TurnRequest;
  readonly surface: TurnSurface;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  sessionId: string | null;
  transport: TurnTransport;
  transportStarted: boolean;
  aborted: boolean;
  /** Hold admission until captured authority is kept/cancelled or prior authority retired. */
  preTransportAdmissionPending: boolean;
  phase: TurnPhase;
}

export interface CreateTurnRequestInput extends Omit<TurnRequest, "workspace"> {
  workspace: TurnWorkspaceAuthority | null | undefined;
}

export interface CreateTurnControlInput extends Pick<
  TurnControl,
  "surface" | "userMessageId" | "assistantMessageId" | "transport"
> {
  request: TurnRequest;
}

export function createTurnRequest(input: CreateTurnRequestInput): TurnRequest {
  const workspace = input.workspace
    ? Object.freeze({ ...input.workspace })
    : null;
  return Object.freeze({
    requestId: input.requestId,
    workspace,
    projectId: input.projectId,
    sceneId: input.sceneId,
    sessionId: input.sessionId,
    scope: input.scope,
    scopeAnchorId: input.scopeAnchorId,
    routeAuthorityKey: input.routeAuthorityKey,
  });
}

export function createTurnControl(input: CreateTurnControlInput): TurnControl {
  return {
    id: input.request.requestId,
    request: input.request,
    surface: input.surface,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    sessionId: input.request.sessionId,
    transport: input.transport,
    transportStarted: false,
    aborted: false,
    preTransportAdmissionPending: false,
    phase: "preparing",
  };
}

const allowedTransitions: Record<TurnPhase, readonly TurnPhase[]> = {
  preparing: ["streaming", "agent-running", "aborted", "failed"],
  streaming: ["persisting", "completed", "aborted", "failed"],
  "agent-running": ["persisting", "completed", "aborted", "failed"],
  persisting: ["completed", "aborted", "failed"],
  completed: [],
  aborted: [],
  failed: [],
};

function isTerminal(phase: TurnPhase): boolean {
  return phase === "completed" || phase === "aborted" || phase === "failed";
}

export interface TurnCoordinator {
  /** Claim the single active turn slot. A stale caller cannot replace it. */
  claim(control: TurnControl): boolean;
  current(): TurnControl | null;
  isCurrent(control: TurnControl): boolean;
  transition(control: TurnControl, phase: TurnPhase): boolean;
  abort(control?: TurnControl): boolean;
  release(
    control: TurnControl,
    finalPhase?: Extract<TurnPhase, "completed" | "failed">,
  ): boolean;
}

/**
 * Owns active-turn identity without knowing about Zustand, IPC, or providers.
 * The store may still attach cleanup callbacks, but it no longer owns the
 * module-level request/control pointer itself.
 */
export function createTurnCoordinator(): TurnCoordinator {
  let active: TurnControl | null = null;

  return {
    claim(control) {
      if (active !== null && active !== control) return false;
      active = control;
      if (control.phase !== "preparing") control.phase = "preparing";
      return true;
    },

    current() {
      return active;
    },

    isCurrent(control) {
      // Identity remains current until release so Stop can flush the final
      // buffered delta before invalidating the transport callbacks.
      return active === control;
    },

    transition(control, phase) {
      if (active !== control || control.aborted || isTerminal(control.phase)) {
        return false;
      }
      if (!allowedTransitions[control.phase].includes(phase)) return false;
      control.phase = phase;
      return true;
    },

    abort(control) {
      const target = control ?? active;
      if (!target || active !== target || isTerminal(target.phase))
        return false;
      target.aborted = true;
      target.phase = "aborted";
      return true;
    },

    release(control, finalPhase = "completed") {
      if (active !== control) return false;
      if (!isTerminal(control.phase)) {
        control.phase = control.aborted ? "aborted" : finalPhase;
      }
      active = null;
      return true;
    },
  };
}
