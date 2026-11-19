/**
 * Main's turn owner of the Mastra agent route (MP-3c; `docs/plans/mastra-mp3-decisions.md`
 * DR-MP3-4, -5, -6, -7, -10, -11, -12, -13, -16, -17, -23).
 *
 * One turn is one `mastra_agent_turn_start`: Main checks the sender, loads the
 * runtime (lazily, only while the gate is open), builds the turn's audit sink
 * and its send, and runs one Mastra `generate` (tool 0, one step, no retry).
 * The turn is bound to the sender, its window and the caller identity Main
 * issued; the LLM request is still Rust's `send_agent_message`, called through
 * Main's own closure (`backend.sendAgentMessage`) with settings and key
 * resolved once per send by `resolveRequiredAiKeyAndSettings`.
 *
 * Aborts are of two kinds (DR-MP3-6):
 * - `user-stop` (a cancel): the turn does not begin another step. This route has
 *   one step, so a cancel before the dispatch row ends the turn as
 *   `execution.cancelled`; after it, the send in flight finishes as it does
 *   today (a stop that does not cut a provider call).
 * - `forced` (restricted, workspace switch, quit, sender gone): the owner closes
 *   admission, races the turn with the abort so its caller settles at once,
 *   and writes the ambiguous terminal of the execution (once; the sink holds
 *   one terminal per execution). The Native send is not stopped (no new
 *   cancel contract): a late settle of it is dropped, never returned and never
 *   a second terminal.
 *
 * Nothing here opens a new destination, event type, path ID, Native entry or
 * capability. It imports no `@mastra/*`: the runtime comes from `mastraAgentLoader.ts`.
 */
import {
  resolveRequiredAiKeyAndSettings,
  type CommandArgs,
  type NapiBackendLike,
  type SecretsResolver,
} from "../shared/ipcContract.js";
import {
  mastraAgentTurnRefusalValue,
  MASTRA_AGENT_TURN_START_COMMAND,
  type MastraAgentTurnCancelRequest,
  type MastraAgentTurnCancelResult,
  type MastraAgentTurnRefusalReason,
  type MastraAgentTurnStartRequest,
  type MastraAgentTurnStartResult,
} from "../shared/mastraAgentTurnWire.js";
import { isAgentModelError } from "./mastra/agentModelPolicy.js";
import {
  createMainAgentAuditSink,
  type MainAgentAmbiguousCause,
  type MainAgentAuditHandle,
  type MainAgentAuditSink,
} from "./mastra/agentAuditSink.js";
import type {
  AgentAuditCompletion,
  AgentAuditRequest,
  AgentRoute,
  AgentSend,
  AgentWireArgs,
  AgentWireResponse,
} from "./mastra/agentWire.js";
import type {
  MastraAgentRuntime,
  MastraAgentRuntimeModule,
} from "./mastra/agentRuntime.js";
import type {
  MastraAgentTurnSender,
  MastraAgentTurnWindow,
} from "./mastraAgentTurnGate.js";
import type { MainEgressParticipantContext } from "./profileEgress.js";

/** `T_quit`: the quit finalizer's wait for the owner (provisional; DR-MP3-13, P11). */
export const MASTRA_TURN_QUIT_BOUND_MS = 5_000;
/** The bound of a workspace switch's wait for the turns' terminals (the participant frame, DR-MP3-12). */
export const MASTRA_TURN_FORCED_BOUND_MS = 30_000;
/** Turns one sender may hold at once (DR-MP3-4). */
export const MASTRA_TURN_PER_SENDER_MAX = 4;
/** Turns Main holds at once (DR-MP3-4). */
export const MASTRA_TURN_TOTAL_MAX = 8;

const START_COMMAND = MASTRA_AGENT_TURN_START_COMMAND;

// ---------------------------------------------------------------------------
// The causes a turn can end for, as errors the adapter hands to the sink.
// ---------------------------------------------------------------------------

/** A forced abort. The sink writes the ambiguous terminal with `cause`. */
class MastraTurnAborted extends Error {
  readonly cause2: MainAgentAmbiguousCause;
  constructor(cause: MainAgentAmbiguousCause) {
    super(`MASTRA_AGENT_TURN_ABORTED: ${cause}`);
    this.name = "MastraTurnAborted";
    this.cause2 = cause;
  }
}

/** A stop the user asked for, before the dispatch. */
class MastraTurnCancelled extends Error {
  constructor() {
    super("MASTRA_AGENT_TURN_CANCELLED: the turn was stopped before dispatch");
    this.name = "MastraTurnCancelled";
  }
}

// ---------------------------------------------------------------------------
// What the owner needs of Electron and of the profile gate.
// ---------------------------------------------------------------------------

export interface MastraTurnSender extends MastraAgentTurnSender {
  on(event: "destroyed", listener: () => void): unknown;
  on(event: "render-process-gone", listener: () => void): unknown;
  on(
    event: "did-start-navigation",
    listener: (details?: {
      isMainFrame?: boolean;
      isSameDocument?: boolean;
    }) => void,
  ): unknown;
  removeListener(
    event: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (...args: any[]) => void,
  ): unknown;
}

export interface MastraTurnWindow extends MastraAgentTurnWindow {
  on(event: "closed", listener: () => void): unknown;
  removeListener(
    event: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (...args: any[]) => void,
  ): unknown;
}

export interface MastraTurnInvokeContext {
  readonly sender: MastraTurnSender;
  readonly win: MastraTurnWindow | null;
  /** The identity the router issued for this invoke. */
  readonly callerIdentity: unknown;
}

/** The profile gate's reads the owner uses (`ProfileEgressGate` satisfies it). */
export interface MastraTurnProfile {
  isIssuedCallerIdentity(identity: unknown): boolean;
  readonly restricted: boolean;
  readonly unavailable: boolean;
  readonly activating: boolean;
}

export type MastraTurnBackend = NapiBackendLike;

export interface MastraTurnOwnerOptions {
  /** Whether the journey seam opened Main's gate. A closed owner loads nothing. */
  readonly open: boolean;
  readonly backend: MastraTurnBackend | null;
  readonly secrets?: SecretsResolver;
  readonly profile: MastraTurnProfile;
  /** `loader.load` of `mastraAgentLoader.ts`; called only while the gate is open. */
  readonly loadRuntime: () => Promise<MastraAgentRuntimeModule>;
  /** `app.getVersion()`. */
  readonly appVersion: string;
  /** Receives fixed texts only (never an error's own message of a request). */
  readonly log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => void;
  readonly quitBoundMs?: number;
  readonly forcedBoundMs?: number;
  readonly perSenderMax?: number;
  readonly totalMax?: number;
  readonly randomUUID?: () => string;
}

/** A workspace switch's lease: `resume` reopens admission. Idempotent. */
export interface MastraTurnSwitchLease {
  resume(success: boolean): Promise<void>;
}

export interface MastraTurnOwner {
  /** The route's `MastraAgentTurnOwnerPort` (it takes the invoke's real Electron objects). */
  start(
    context: MastraTurnInvokeContext,
    request: MastraAgentTurnStartRequest,
  ): Promise<MastraAgentTurnStartResult>;
  cancel(
    context: MastraTurnInvokeContext,
    request: MastraAgentTurnCancelRequest,
  ): MastraAgentTurnCancelResult;
  /** The egress participant's quiesce: close admission, abort, wait for the terminals. */
  quiesceForProfileEgress(
    context?: MainEgressParticipantContext,
  ): Promise<void>;
  /** The egress participant's force stop (the gate's bound ran out). Not awaited by the gate. */
  forceStopForProfileEgress(): void;
  /** The workspace switch's lease (`ipc.ts`): close admission, abort, write the terminals before Native's open. */
  quiesceForWorkspaceSwitch(): Promise<MastraTurnSwitchLease>;
  /** The quit finalizer's call (dispose and complete both): bounded, idempotent, never rejects. */
  shutdown(): Promise<void>;
  /** A backend event: a changed workspace binding ends the turns whose identity is no longer issued. */
  handleBackendEvent(channel: string, payload: unknown): void;
  /** How many turns are attached (running or preparing). */
  activeTurnCount(): number;
  /** Turns plus the Native sends a forced abort detached from (slots in use). */
  slotsInUse(): number;
}

// ---------------------------------------------------------------------------
// The turn table.
// ---------------------------------------------------------------------------

interface Turn {
  readonly turnId: string;
  readonly sender: MastraTurnSender;
  readonly senderId: number;
  readonly windowId: number;
  readonly sessionKey: string;
  readonly identity: unknown;
  readonly controller: AbortController;
  sink: MainAgentAuditSink;
  handle: MainAgentAuditHandle | null;
  beginPromise: Promise<unknown> | null;
  userStop: boolean;
  /** A guard ended the turn as cancelled (the user's stop before the dispatch). */
  cancelObserved: boolean;
  forcedCause: MainAgentAmbiguousCause | null;
  forcedTerminal: Promise<void> | null;
  rejectForced: (error: Error) => void;
  /** Native sends of this turn that have not settled (a detached one still counts). */
  nativeInFlight: number;
  /** The raw response the adapter's send received and the sink completed. */
  response: Record<string, unknown> | null;
  /** The owner's caller is done (returned or rejected). */
  finished: boolean;
  slotReleased: boolean;
  detach: () => void;
}

function sessionKeyOf(senderId: number, chatSessionId: string): string {
  return `${senderId}\u0000${chatSessionId}`;
}

function refusal(
  reason: MastraAgentTurnRefusalReason,
): MastraAgentTurnStartResult {
  return mastraAgentTurnRefusalValue(
    START_COMMAND,
    reason,
  ) as MastraAgentTurnStartResult;
}

export function createMastraTurnOwner(
  options: MastraTurnOwnerOptions,
): MastraTurnOwner {
  const log = options.log ?? (() => undefined);
  const quitBoundMs = options.quitBoundMs ?? MASTRA_TURN_QUIT_BOUND_MS;
  const forcedBoundMs = options.forcedBoundMs ?? MASTRA_TURN_FORCED_BOUND_MS;
  const perSenderMax = options.perSenderMax ?? MASTRA_TURN_PER_SENDER_MAX;
  const totalMax = options.totalMax ?? MASTRA_TURN_TOTAL_MAX;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());

  /** Turns an owner's caller still waits on, by turn ID. */
  const attached = new Map<string, Turn>();
  const bySession = new Map<string, Turn>();
  /** Turns holding a slot: attached ones, and detached ones whose Native send has not settled. */
  const slots = new Set<Turn>();
  /** closed-profile and closed-quit are one-way; a switch is a counter that resume lowers. */
  let closed: "profile" | "quit" | null = null;
  let switchDepth = 0;
  let shutdownPromise: Promise<void> | null = null;
  let runtimePromise: Promise<MastraAgentRuntime> | null = null;

  const profileClosed = (): boolean =>
    options.profile.restricted ||
    options.profile.unavailable ||
    options.profile.activating;

  const senderCount = (senderId: number): number => {
    let count = 0;
    for (const turn of slots) if (turn.senderId === senderId) count += 1;
    return count;
  };

  const releaseSlotIfIdle = (turn: Turn): void => {
    if (turn.slotReleased) return;
    if (turn.finished && turn.nativeInFlight === 0) {
      turn.slotReleased = true;
      slots.delete(turn);
    }
  };

  const loadRuntime = (): Promise<MastraAgentRuntime> => {
    if (runtimePromise === null) {
      runtimePromise = options.loadRuntime().then(
        (module) =>
          module.createMastraAgentRuntime({
            log: (level, message) => log(level, `mastra: ${message}`),
          }),
        (error) => {
          // A failed load is not cached: the next start tries once.
          runtimePromise = null;
          throw error;
        },
      );
    }
    return runtimePromise;
  };

  /**
   * Forced abort (DR-MP3-6): once per turn. The caller's race settles at once
   * (`rejectForced`), the run's signal aborts, and the ambiguous terminal is
   * written after any begin in flight (so the handle exists), unless no row
   * was ever started. Returns the terminal's promise, which a caller bounds.
   */
  const forceAbort = (
    turn: Turn,
    cause: MainAgentAmbiguousCause,
  ): Promise<void> => {
    if (turn.forcedTerminal !== null) return turn.forcedTerminal;
    turn.forcedCause = cause;
    turn.controller.abort();
    turn.rejectForced(new MastraTurnAborted(cause));
    const terminal = (async (): Promise<void> => {
      if (turn.beginPromise !== null) {
        await turn.beginPromise.then(
          () => undefined,
          () => undefined,
        );
      }
      if (turn.handle !== null) {
        await turn.sink.ambiguous(turn.handle, { cause });
      }
    })();
    // The turn's own caller never awaits it: a failure is logged, and the
    // callers that bound it (quiesce, lease, shutdown) read the same promise.
    terminal.catch(() => {
      log(
        "warn",
        "main agent turn: the ambiguous terminal could not be written",
      );
    });
    turn.forcedTerminal = terminal;
    return terminal;
  };

  /** Each send and each begin: the turn's own checks before anything leaves Main (DR-MP3-5). */
  const assertLive = (turn: Turn): void => {
    if (turn.forcedCause !== null)
      throw new MastraTurnAborted(turn.forcedCause);
    if (turn.userStop) {
      turn.cancelObserved = true;
      throw new MastraTurnCancelled();
    }
    if (profileClosed()) {
      void forceAbort(turn, "restricted");
      throw new MastraTurnAborted("restricted");
    }
    if (
      turn.sender.isDestroyed() ||
      !options.profile.isIssuedCallerIdentity(turn.identity)
    ) {
      // The identity is replaced by a workspace change, an epoch or an
      // activation; the sender is gone when it is destroyed.
      const cause = turn.sender.isDestroyed()
        ? "sender-gone"
        : "workspace-switch";
      void forceAbort(turn, cause);
      throw new MastraTurnAborted(cause);
    }
  };

  // -------------------------------------------------------------------------
  // The turn's sink: Main's sink, with the owner's checks and bookkeeping.
  // -------------------------------------------------------------------------

  const guardedSink = (turn: Turn): MainAgentAuditSink => {
    const inner = turn.sink;
    return {
      async begin(request: AgentAuditRequest) {
        assertLive(turn);
        const begun = inner.begin(request).then((handle) => {
          // Set inside the chain: a forced abort waiting for this begin sees it.
          turn.handle = handle;
          return handle;
        });
        turn.beginPromise = begun;
        const handle = await begun;
        if (turn.forcedCause !== null)
          throw new MastraTurnAborted(turn.forcedCause);
        return handle;
      },
      async dispatched(handle) {
        assertLive(turn);
        await inner.dispatched(handle);
      },
      async complete(handle, completion: AgentAuditCompletion) {
        // A forced abort already closed the execution: the late completion is dropped.
        if (turn.forcedCause !== null) return;
        await inner.complete(handle, completion);
        turn.response = completion.response as unknown as Record<
          string,
          unknown
        >;
      },
      async fail(handle, error) {
        if (error instanceof MastraTurnCancelled) {
          await inner.cancel(handle, { reason: "user-stop" });
        } else if (error instanceof MastraTurnAborted) {
          await inner.ambiguous(handle, { cause: error.cause2 });
        } else {
          await inner.fail(handle, error);
        }
      },
      ambiguous: (handle, input) => inner.ambiguous(handle, input),
      cancel: (handle, input) => inner.cancel(handle, input),
    };
  };

  // -------------------------------------------------------------------------
  // The turn's send: Native's `send_agent_message`, through Main's own closure.
  // -------------------------------------------------------------------------

  const sendFor = (turn: Turn, backend: MastraTurnBackend): AgentSend => {
    return async (args: AgentWireArgs) => {
      assertLive(turn);
      // Native does not take the caller identity here: a legacy permit, and the
      // identity was checked just above (DR-MP3-5). Never forwarded.
      const { callerIdentity: _identity, ...nativeArgs } = args;
      const send = backend.sendAgentMessage;
      if (typeof send !== "function") {
        throw new Error("IPC_BACKEND_UNAVAILABLE: sendAgentMessage");
      }
      // Settings and the key are resolved here, once for this send, through
      // the contract's own function (not a copy).
      const { settings, apiKey } = await resolveRequiredAiKeyAndSettings(
        backend,
        nativeArgs as unknown as CommandArgs,
        {
          backend: backend,
          shell: {},
          secrets: options.secrets,
        },
        "mastra_agent_turn_start",
      );
      // The identity and the profile may have changed during the await.
      assertLive(turn);
      turn.nativeInFlight += 1;
      let pending: Promise<string>;
      try {
        pending = Promise.resolve(
          send.call(backend, nativeArgs, settings, apiKey),
        );
      } catch (error) {
        turn.nativeInFlight -= 1;
        releaseSlotIfIdle(turn);
        throw error;
      }
      // The slot is held until Native's own settle, whoever stopped waiting.
      const settled = (): void => {
        turn.nativeInFlight -= 1;
        releaseSlotIfIdle(turn);
      };
      pending.then(settled, settled);
      const raw = await pending;
      return JSON.parse(raw) as AgentWireResponse;
    };
  };

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  /** The wire's messages as the runtime takes them: the leading system as `instructions`. */
  function splitMessages(request: MastraAgentTurnStartRequest): {
    readonly instructions: string;
    readonly messages: { role: "user" | "assistant"; content: string }[];
  } | null {
    const [first, ...rest] = request.messages;
    if (first === undefined || first.role !== "system") return null;
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    for (const message of rest) {
      if (message.role === "system") return null;
      messages.push({ role: message.role, content: message.content });
    }
    const last = messages[messages.length - 1];
    if (last === undefined || last.role !== "user") return null;
    return { instructions: first.content, messages };
  }

  function attachListeners(turn: Turn, context: MastraTurnInvokeContext): void {
    const { sender, win } = context;
    const onGone = (): void => {
      void forceAbort(turn, "sender-gone");
    };
    const onNavigation = (details?: {
      isMainFrame?: boolean;
      isSameDocument?: boolean;
    }): void => {
      // A frame of the page, or a same-document change (history API), does not
      // end the renderer's own session; a reload or a new document does.
      if (details?.isMainFrame === false || details?.isSameDocument === true) {
        return;
      }
      onGone();
    };
    sender.on("destroyed", onGone);
    sender.on("render-process-gone", onGone);
    sender.on("did-start-navigation", onNavigation);
    win?.on("closed", onGone);
    turn.detach = () => {
      sender.removeListener("destroyed", onGone);
      sender.removeListener("render-process-gone", onGone);
      sender.removeListener("did-start-navigation", onNavigation);
      win?.removeListener("closed", onGone);
    };
  }

  /** The error the start rejects with, from what ended the turn. */
  function endError(turn: Turn, error: unknown): Error {
    // By the turn's own state first: Mastra and the adapter wrap what the
    // sink's guards throw, so the error's class is not what tells the cause.
    if (turn.forcedCause !== null)
      return new MastraTurnAborted(turn.forcedCause);
    if (turn.cancelObserved) return new MastraTurnCancelled();
    if (error instanceof MastraTurnCancelled) return error;
    if (error instanceof MastraTurnAborted) return error;
    // The adapter wraps a send's failure; the renderer sees the cause's message,
    // as a failed legacy send shows it.
    const cause =
      isAgentModelError(error) && error.origin !== undefined
        ? error.origin
        : error;
    return new Error(cause instanceof Error ? cause.message : String(cause));
  }

  const admissionRefusal = (
    context: MastraTurnInvokeContext,
    request: MastraAgentTurnStartRequest,
  ): MastraAgentTurnStartResult | null => {
    if (!options.open) return refusal("gate-closed");
    if (closed === "quit") return refusal("unsupported");
    if (closed === "profile" || profileClosed()) return refusal("restricted");
    const { sender, win, callerIdentity } = context;
    if (
      sender.isDestroyed() ||
      !win ||
      win.isDestroyed() ||
      typeof callerIdentity !== "object" ||
      callerIdentity === null ||
      (callerIdentity as { senderId?: unknown }).senderId !== sender.id ||
      !options.profile.isIssuedCallerIdentity(callerIdentity)
    ) {
      return refusal("sender-refused");
    }
    if (switchDepth > 0) return refusal("busy");
    if (
      attached.has(request.turnId) ||
      bySession.has(sessionKeyOf(sender.id, request.chatSessionId)) ||
      senderCount(sender.id) >= perSenderMax ||
      slots.size >= totalMax
    ) {
      return refusal("busy");
    }
    return null;
  };

  async function start(
    context: MastraTurnInvokeContext,
    request: MastraAgentTurnStartRequest,
  ): Promise<MastraAgentTurnStartResult> {
    const refused = admissionRefusal(context, request);
    if (refused !== null) return refused;
    const { sender, win, callerIdentity } = context;
    if (!win) return refusal("sender-refused");
    const backend = options.backend;
    const split = splitMessages(request);
    const workspacePath = (callerIdentity as { workspaceId?: unknown })
      .workspaceId;
    if (
      backend === null ||
      typeof backend.sendAgentMessage !== "function" ||
      typeof backend.aiAuditAppendBatch !== "function" ||
      split === null ||
      typeof workspacePath !== "string" ||
      workspacePath.trim() === ""
    ) {
      return refusal("unsupported");
    }

    let rejectForced: (error: Error) => void = () => undefined;
    const forcedRace = new Promise<never>((_resolve, reject) => {
      rejectForced = reject;
    });
    // The race is awaited below; this keeps an abort that nobody awaits (the
    // turn ended first) from being an unhandled rejection.
    forcedRace.catch(() => undefined);
    const sink = createMainAgentAuditSink({
      backend,
      appVersion: options.appVersion,
      // The wire carries no project: the rows go in the workspace chain (DR-MP3-23).
      projectId: null,
      expectedWorkspacePath: workspacePath,
      randomUUID,
    });
    const turn: Turn = {
      turnId: request.turnId,
      sender,
      senderId: sender.id,
      windowId: win.id,
      sessionKey: sessionKeyOf(sender.id, request.chatSessionId),
      identity: callerIdentity,
      controller: new AbortController(),
      sink,
      handle: null,
      beginPromise: null,
      userStop: false,
      cancelObserved: false,
      forcedCause: null,
      forcedTerminal: null,
      rejectForced,
      nativeInFlight: 0,
      response: null,
      finished: false,
      slotReleased: false,
      detach: () => undefined,
    };
    // From here to the first await nothing else runs: the table and the
    // listeners are in place before the turn can be reached.
    attached.set(turn.turnId, turn);
    bySession.set(turn.sessionKey, turn);
    slots.add(turn);
    attachListeners(turn, context);

    try {
      const runtime = await Promise.race([loadRuntime(), forcedRace]);
      // Stopped or detached while the runtime was loading: no row was written.
      if (turn.forcedCause !== null)
        throw new MastraTurnAborted(turn.forcedCause);
      if (turn.userStop) {
        turn.cancelObserved = true;
        throw new MastraTurnCancelled();
      }
      const run = runtime.runTurn({
        instructions: split.instructions,
        messages: split.messages,
        route: request.route as unknown as AgentRoute,
        systemCacheSegments: request.systemCacheSegments,
        systemVolatileTail: request.systemVolatileTail,
        send: sendFor(turn, backend),
        audit: guardedSink(turn),
        signal: turn.controller.signal,
      });
      // A turn the owner stopped waiting on keeps running in the background
      // until its send settles; its late rejection is dropped.
      run.catch(() => undefined);
      await Promise.race([run, forcedRace]);
      const { handle, response } = turn;
      if (turn.forcedCause !== null)
        throw new MastraTurnAborted(turn.forcedCause);
      if (handle === null || response === null) {
        throw new Error(
          "MASTRA_AGENT_TURN_NO_RESPONSE: the turn ended without a provider response",
        );
      }
      return {
        status: "completed",
        turnId: turn.turnId,
        executionId: handle.executionId,
        response,
      };
    } catch (error) {
      throw endError(turn, error);
    } finally {
      turn.finished = true;
      attached.delete(turn.turnId);
      if (bySession.get(turn.sessionKey) === turn)
        bySession.delete(turn.sessionKey);
      turn.detach();
      releaseSlotIfIdle(turn);
    }
  }

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  function cancel(
    context: MastraTurnInvokeContext,
    request: MastraAgentTurnCancelRequest,
  ): MastraAgentTurnCancelResult {
    const turn = attached.get(request.turnId);
    // Only the sender that started a turn (in its own window) can stop it.
    if (
      turn === undefined ||
      turn.senderId !== context.sender.id ||
      turn.windowId !== context.win?.id
    ) {
      return { status: "ok", turnId: request.turnId, found: false };
    }
    // `user-stop`: no step begins after this (a send in flight is not cut).
    turn.userStop = true;
    return { status: "ok", turnId: request.turnId, found: true };
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  const attachedTurns = (): Turn[] => [...attached.values()];

  return {
    start: (context, request) => start(context, request),
    cancel: (context, request) => cancel(context, request),

    async quiesceForProfileEgress(context) {
      // Admission first, and for good (a restricted or unavailable profile
      // does not reopen until the process restarts).
      closed ??= "profile";
      const turns = attachedTurns();
      if (turns.length === 0) return;
      const inNative = turns.some((turn) => turn.nativeInFlight > 0);
      const terminals = turns.map((turn) => forceAbort(turn, "restricted"));
      // Reserved: Native's own stop request for what is in Native, only when
      // something of ours is (a launch with no turn leaves stage 5 as it was).
      if (inNative) context?.abortNativeInFlight();
      // A terminal that cannot be written fails the quiesce: the activation
      // fails closed (unavailable), the existing path.
      await Promise.all(terminals);
    },

    forceStopForProfileEgress() {
      for (const turn of attachedTurns()) void forceAbort(turn, "restricted");
    },

    async quiesceForWorkspaceSwitch() {
      switchDepth += 1;
      let resumed = false;
      const lease: MastraTurnSwitchLease = {
        async resume() {
          if (resumed) return;
          resumed = true;
          switchDepth = Math.max(0, switchDepth - 1);
        },
      };
      const turns = attachedTurns();
      if (turns.length === 0) return lease;
      const terminals = turns.map((turn) =>
        forceAbort(turn, "workspace-switch"),
      );
      let timer: ReturnType<typeof setTimeout> | null = null;
      const bound = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), forcedBoundMs);
      });
      try {
        const outcome = await Promise.race([
          Promise.allSettled(terminals),
          bound,
        ]);
        if (outcome === "timeout") {
          log(
            "warn",
            "main agent turn: terminals not written within the switch bound",
          );
        }
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      return lease;
    },

    shutdown() {
      if (shutdownPromise !== null) return shutdownPromise;
      closed = "quit";
      shutdownPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          const turns = attachedTurns();
          if (turns.length === 0) return;
          const terminals = turns.map((turn) =>
            forceAbort(turn, "quit").then(
              () => undefined,
              () => undefined,
            ),
          );
          const bound = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, quitBoundMs);
          });
          await Promise.race([Promise.all(terminals), bound]);
        } catch {
          // Bounded and never rejecting: a failure leaves a start-only row, which the report counts.
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      })();
      return shutdownPromise;
    },

    handleBackendEvent(channel) {
      if (
        channel !== "workspace:opened" &&
        channel !== "workspace:lifecycle-state"
      ) {
        return;
      }
      // Only a replaced identity ends a turn (a lifecycle event that changes
      // nothing does not): the profile gate has already observed the event.
      for (const turn of attachedTurns()) {
        if (!options.profile.isIssuedCallerIdentity(turn.identity)) {
          void forceAbort(turn, "workspace-switch");
        }
      }
    },

    activeTurnCount: () => attached.size,
    slotsInUse: () => slots.size,
  };
}
