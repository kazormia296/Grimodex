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
  type NapiBackendLike,
  type SecretsResolver,
} from "../shared/ipcContract.js";
import {
  mastraAgentTurnRefusalValue,
  MASTRA_AGENT_TURN_START_COMMAND,
  type MastraAgentTurnProgressUsage,
  type MastraAgentTurnProgressEvent,
  type MastraAgentTurnCancelRequest,
  type MastraAgentTurnCancelResult,
  type MastraAgentTurnRefusalReason,
  type MastraAgentTurnStartRequest,
  type MastraAgentTurnStartResult,
} from "../shared/mastraAgentTurnWire.js";
import type {
  MastraAgentTurnCitation,
  MastraAgentTurnLoopResult,
  MastraAgentTurnThinkingBlock,
  MastraAgentTurnToolCallRecord,
} from "../shared/mastraAgentTurnWire.js";
import {
  ContextWindowExceededError,
  finalizeTurnPayload,
  TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
} from "../shared/turnPayloadFinalizer.js";
import {
  renderAgentConversationPayloads,
  renderAgentToolPayloads,
} from "../shared/agentPayloadRenderer.js";
import {
  createM4ReadToolDefinitions,
  type M4ReadToolName,
} from "../shared/agentReadToolDefinitions.js";
import type * as MastraTurnReadBindings from "./mastraTurnReadBindings.js";
import type { CoreTokenizer } from "../shared/mastraRead/tokenizer.js";
import { isAgentModelError } from "./mastra/agentModelPolicy.js";
import {
  createAgentLoopRuleState,
  getAgentLimitReason,
  insertLimitMessage,
  markAgentLoopAborted,
  recordToolResultTokens,
  recordToolUsesForResponse,
  resolveAgentStoppedReason,
  selectAgentControlMessage,
} from "./mastra/agentLoopRules.js";
import {
  createMainAgentAuditSink,
  type MainAgentAmbiguousCause,
  type MainAgentAuditHandle,
  type MainAgentAuditSink,
} from "./mastra/agentAuditSink.js";
import { projectAiChatPolicyAllows } from "./mastraChatPolicy.js";
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
import { createMastraAgentTurnProgressSender } from "./mastraAgentTurnEvents.js";
import type { MainReadHooks } from "./mastraRead/nativeCall.js";
import type {
  MainEgressParticipantContext,
  MainIssuedCallerIdentity,
} from "./profileEgress.js";

/** `T_quit`: the quit finalizer's wait for the owner (provisional; DR-MP3-13, P11). */
export const MASTRA_TURN_QUIT_BOUND_MS = 5_000;
/** The bound of a workspace switch's wait for the turns' terminals (the participant frame, DR-MP3-12). */
export const MASTRA_TURN_FORCED_BOUND_MS = 30_000;
/** Turns one sender may hold at once (DR-MP3-4). */
export const MASTRA_TURN_PER_SENDER_MAX = 4;
/** Turns Main holds at once (DR-MP3-4). */
export const MASTRA_TURN_TOTAL_MAX = 8;

/**
 * The renderer's fallback project ID (`FALLBACK_PROJECT_ID` in
 * `src/application/project/currentProjectAuthority.ts`): it names no project.
 * The wire file takes no import, so the literal is here and a test holds it
 * against the renderer's (DR-MP4-1).
 */
export const MASTRA_TURN_FALLBACK_PROJECT_ID = "default-project";

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

/** Stop a later loop send without creating a second audit execution. */
export class MastraAgentLoopStopped extends Error {
  constructor() {
    super("MASTRA_AGENT_LOOP_STOPPED: user-stop before the next send");
    this.name = "MastraAgentLoopStopped";
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
  readonly tokenizer?: CoreTokenizer;
  readonly secrets?: SecretsResolver;
  readonly profile: MastraTurnProfile;
  /** `loader.load` of `mastraAgentLoader.ts`; called only while the gate is open. */
  readonly loadRuntime: () => Promise<MastraAgentRuntimeModule>;
  /** Loaded only for a turn that declares read tools. */
  readonly loadReadBindings?: () => Promise<
    typeof import("./mastraTurnReadBindings.js")
  >;
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
  /** Whether Main's gate is open for this launch: the one reading the router uses too. */
  readonly open: boolean;
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
  /** Turns plus the Native sends and reads a forced abort detached from (slots in use). */
  slotsInUse(): number;
  /**
   * The read lifecycle of one attached turn (DR-MP4-5): the `assertLive` and
   * the in-flight count a Native read is put between. `null` when no such turn
   * is attached. Nothing in the product calls it yet (no tool is connected);
   * tests do. Take it before a forced abort: the abort takes the turn out of
   * the table, but the hooks keep working for the turn they were made for.
   */
  readHooks(turnId: string): MainReadHooks | null;
  /** Native reads, over all turns, that have not settled (a timed-out one still counts). */
  readsInFlight(): number;
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
  /**
   * The three fields of the start request, bound once at start and never
   * changed in the turn (DR-MP4-1). Claims of the renderer, form-checked by the
   * wire parser only. `projectId` is the audit scope the sink appends to and
   * the send names; `chatMessageId` rides the send's arguments.
   */
  readonly projectId: string;
  readonly currentSceneId: string | null;
  readonly chatMessageId: string;
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
  /**
   * Native reads of this turn that have not settled (DR-MP4-5; counted apart
   * from the sends). A read whose caller timed out still counts until Native's
   * own settle.
   */
  readInFlight: number;
  /** Resolvers waiting for `readInFlight` to reach 0. */
  readIdleWaiters: (() => void)[];
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

function progressUsage(
  usage: {
    systemTokens: number;
    conversationTokens: number;
    toolTokens: number;
    envelopeTokens: number;
    safetyMarginTokens: number;
    inputTokens: number;
    outputReservedTokens: number;
    reservedTotalTokens: number;
    remainingTokens: number;
  },
  contextWindow: number,
  overflowTokens = 0,
): MastraAgentTurnProgressUsage {
  return {
    contextTokens: usage.systemTokens + usage.conversationTokens,
    toolTokens: usage.toolTokens,
    envelopeTokens: usage.envelopeTokens,
    safetyMarginTokens: usage.safetyMarginTokens,
    inputTokens: usage.inputTokens,
    outputReservedTokens: usage.outputReservedTokens,
    reservedTotalTokens: usage.reservedTotalTokens,
    contextWindow,
    remainingTokens: usage.remainingTokens,
    overflowTokens,
  };
}

function findContextWindowExceeded(
  error: unknown,
): ContextWindowExceededError | null {
  const seen = new Set<object>();
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    if (current instanceof ContextWindowExceededError) return current;
    seen.add(current);
    if (isAgentModelError(current)) {
      current = current.origin;
    } else {
      const wrapper = current as { cause?: unknown; origin?: unknown };
      current = wrapper.origin ?? wrapper.cause;
    }
  }
  return null;
}

export function findAgentLoopStopped(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    if (current instanceof MastraAgentLoopStopped) return true;
    seen.add(current);
    if (isAgentModelError(current)) {
      current = current.origin;
    } else {
      const wrapper = current as { cause?: unknown; origin?: unknown };
      current = wrapper.origin ?? wrapper.cause;
    }
  }
  return false;
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
  const m4Tools = new Map(
    createM4ReadToolDefinitions().map((tool) => [tool.name, tool]),
  );

  /** Turns an owner's caller still waits on, by turn ID. */
  const attached = new Map<string, Turn>();
  const bySession = new Map<string, Turn>();
  /** Turns holding a slot: attached ones, and detached ones whose Native send has not settled. */
  const slots = new Set<Turn>();
  /**
   * Turns a forced abort detached from their caller whose ambiguous terminal is
   * still being written. The caller's `finally` takes a turn out of `attached`
   * a few microtasks after the abort, long before the append is done, so the
   * waits (quiesce, lease, quit) must read this set too, or a turn the sender's
   * own destruction just aborted would look like "no turn".
   */
  const forcedPending = new Set<Turn>();
  /** Turns with a Native read that has not settled (attached or not). */
  const readTurns = new Set<Turn>();
  /** closed-profile and closed-quit are one-way; a switch is a counter that resume lowers. */
  let closed: "profile" | "quit" | null = null;
  let switchDepth = 0;
  let shutdownPromise: Promise<void> | null = null;
  let runtimePromise: Promise<MastraAgentRuntime> | null = null;
  let readBindingsPromise: Promise<typeof MastraTurnReadBindings> | null = null;

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
    if (turn.finished && turn.nativeInFlight === 0 && turn.readInFlight === 0) {
      turn.slotReleased = true;
      slots.delete(turn);
    }
  };

  const loadRuntime = (): Promise<MastraAgentRuntime> => {
    if (runtimePromise === null) {
      runtimePromise = options
        .loadRuntime()
        .then((module) =>
          module.createMastraAgentRuntime({
            log: (level, message) => log(level, `mastra: ${message}`),
          }),
        )
        .catch((error: unknown) => {
          // A failed load, or a factory that throws, is not cached: the next
          // start tries once.
          runtimePromise = null;
          throw error;
        });
    }
    return runtimePromise;
  };

  const loadReadBindings = (): Promise<typeof MastraTurnReadBindings> => {
    if (readBindingsPromise === null) {
      if (!options.loadReadBindings) {
        return Promise.reject(
          new Error("MASTRA_AGENT_READ_BINDINGS_UNAVAILABLE"),
        );
      }
      readBindingsPromise = Promise.resolve()
        .then(() => options.loadReadBindings!())
        .catch((error: unknown) => {
          // Failed imports are retried on the next tool turn.
          readBindingsPromise = null;
          throw error;
        });
    }
    return readBindingsPromise;
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
    forcedPending.add(turn);
    const settled = (): void => {
      forcedPending.delete(turn);
    };
    terminal.then(settled, settled);
    return terminal;
  };

  /**
   * Every turn a wait must cover: the attached ones, the detached ones whose
   * terminal is still being written, and the detached ones Native still holds
   * (a send or a read).
   */
  const coveredTurns = (): Turn[] => {
    const covered = new Set<Turn>([
      ...attached.values(),
      ...forcedPending,
      ...readTurns,
    ]);
    for (const turn of slots) if (turn.nativeInFlight > 0) covered.add(turn);
    return [...covered];
  };

  /**
   * Whether a wait must end the turn (`forceAbort`: the terminal) and not only
   * wait for it. A turn that ended normally, whose caller is gone and which
   * only a late read still keeps, already has its terminal: it is waited for
   * (its read), never aborted (no second terminal on an execution that observed
   * its response, and no failing append to fail a quiesce again).
   */
  const needsAbort = (turn: Turn): boolean =>
    !turn.finished || turn.forcedCause !== null || turn.nativeInFlight > 0;

  /**
   * The reads Native still holds, over `turns`: `settled` resolves once every
   * turn has none left (never rejects). `release` takes the waiters out and
   * resolves it, for a wait the bound cut (an unsettled read would otherwise
   * leave one waiter behind per wait).
   */
  const readDrains = (
    turns: Turn[],
  ): { settled: Promise<void>; release: () => void } => {
    const waiters: { turn: Turn; resolve: () => void }[] = [];
    const settled = Promise.all(
      turns.map((turn) =>
        turn.readInFlight === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiters.push({ turn, resolve });
              turn.readIdleWaiters.push(resolve);
            }),
      ),
    ).then(() => undefined);
    return {
      settled,
      release: () => {
        for (const { turn, resolve } of waiters) {
          turn.readIdleWaiters = turn.readIdleWaiters.filter(
            (waiter) => waiter !== resolve,
          );
          resolve();
        }
      },
    };
  };
  /** The profile quiesce's drains, released when the gate force-stops the owner. */
  const profileDrains = new Set<() => void>();

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
  // The turn's reads (DR-MP4-5, W11): the hooks `runNativeRead` puts around a
  // Native read. Nothing connects a read to a turn yet; tests use `readHooks`.
  // -------------------------------------------------------------------------

  /**
   * The same checks as a send's (forced, user stop, the profile's three
   * states, the identity and the sender), called synchronously before the read
   * is sent and again after it answered. A turn the caller already left takes
   * no read (its slot may be released and no wait reads it): that check comes
   * right after the forced one and before the rest, so an ended turn is never
   * aborted nor marked cancelled by a late read.
   */
  const assertReadLive = (turn: Turn): void => {
    if (turn.forcedCause !== null)
      throw new MastraTurnAborted(turn.forcedCause);
    if (turn.finished) {
      throw new Error("MASTRA_TURN_READ_AFTER_END: the turn has ended");
    }
    assertLive(turn);
  };

  /** Counts a read from its start to Native's own settle, whoever stopped waiting. */
  const trackRead = (turn: Turn, settled: Promise<void>): void => {
    turn.readInFlight += 1;
    readTurns.add(turn);
    const done = (): void => {
      turn.readInFlight -= 1;
      if (turn.readInFlight === 0) {
        readTurns.delete(turn);
        const waiters = turn.readIdleWaiters;
        turn.readIdleWaiters = [];
        for (const resolve of waiters) resolve();
      }
      releaseSlotIfIdle(turn);
    };
    settled.then(done, done);
  };

  const readHooksOf = (turn: Turn): MainReadHooks => ({
    assertLive: () => assertReadLive(turn),
    trackInFlight: (settled) => trackRead(turn, settled),
  });

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

  const sendFor = (
    turn: Turn,
    backend: MastraTurnBackend,
    credentials: { readonly settings: unknown; readonly apiKey: string },
  ): AgentSend => {
    return async (args: AgentWireArgs) => {
      assertLive(turn);
      // Native does not take the caller identity here: a legacy permit, and the
      // identity was checked just above (DR-MP3-5). Never forwarded.
      const { callerIdentity: _identity, ...nativeArgs } = args;
      const send = backend.sendAgentMessage;
      if (typeof send !== "function") {
        throw new Error("IPC_BACKEND_UNAVAILABLE: sendAgentMessage");
      }
      // Settings and the key were resolved once, before the turn began
      // (`start`): a run that cannot be sent is never begun (DR-MP3-13).
      const { settings, apiKey } = credentials;
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
    const model = request.route.model;
    if (typeof model !== "string" || model.trim() === "") {
      return refusal("invalid");
    }
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
      // The fallback project ID names no project (DR-MP4-1); the renderer does
      // not start this route for it, and Main refuses it too.
      request.projectId === MASTRA_TURN_FALLBACK_PROJECT_ID ||
      typeof workspacePath !== "string" ||
      workspacePath.trim() === ""
    ) {
      return refusal("unsupported");
    }
    // The budget is counted on `loop.fallbackSystem`, and the model is sent the
    // leading system message (`split.instructions`). They are one text (the
    // legacy agent path passes the same string as both); where they differ the
    // budget would judge text that is not sent, so the start is refused.
    if (split.instructions !== request.loop.fallbackSystem) {
      return refusal("invalid");
    }
    const tokenizer = options.tokenizer;
    if (!tokenizer) return refusal("unsupported");
    // The wire admits only M4 names, so an unknown one is a desync of this
    // build: refused here, before the turn is registered.
    const toolDefinitions: ReturnType<typeof createM4ReadToolDefinitions> = [];
    for (const name of request.tools) {
      const definition = m4Tools.get(name);
      if (!definition) return refusal("invalid");
      toolDefinitions.push(definition);
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
      // The rows go in the project's chain, as the legacy route's do. The sink
      // hands this one value to the append and to the send's audit context, so
      // Native's dispatch precondition checks the same scope the rows are in.
      projectId: request.projectId,
      chatMessageId: request.chatMessageId,
      expectedWorkspacePath: workspacePath,
      randomUUID,
    });
    const turn: Turn = {
      turnId: request.turnId,
      sender,
      senderId: sender.id,
      windowId: win.id,
      sessionKey: sessionKeyOf(sender.id, request.chatSessionId),
      projectId: request.projectId,
      currentSceneId: request.currentSceneId,
      chatMessageId: request.chatMessageId,
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
      readInFlight: 0,
      readIdleWaiters: [],
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
    const progress = createMastraAgentTurnProgressSender(sender, turn.turnId);
    let loopState = createAgentLoopRuleState({
      tokenBudget: request.loop.tokenBudget,
      maxToolCalls: request.loop.maxToolCalls,
      maxUserQuestions: request.loop.maxUserQuestions,
    });
    let finalText = "";
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let cost: number | null = null;
    const toolCallRecords: MastraAgentTurnToolCallRecord[] = [];
    const toolCallRecordIndexes = new Map<string, number>();
    const startedToolCallIds = new Set<string>();
    const completedToolCallIds = new Set<string>();
    let declaredToolNames = new Set<string>();
    const citations: MastraAgentTurnCitation[] = [];
    let finalThinkingBlocks: MastraAgentTurnThinkingBlock[] = [];
    let terminalSent = false;
    const makeLoopResult = (
      stoppedReason = loopState.aborted
        ? "aborted"
        : (getAgentLimitReason(loopState) ??
          resolveAgentStoppedReason(loopState)),
    ): MastraAgentTurnLoopResult => ({
      finalText,
      toolCallRecords,
      stoppedReason,
      usage: { totalTokens: loopState.tokensUsed, tokensIn, tokensOut, cost },
      citations,
      finalThinkingBlocks,
    });
    const sendTerminalProgress = (
      event: MastraAgentTurnProgressEvent,
    ): boolean => {
      if (terminalSent) return false;
      terminalSent = true;
      progress.send(event);
      return true;
    };
    const controlMessages = {
      uiLanguage: request.loop.language,
      ...request.loop.controlMessages,
    };

    try {
      // The tokenizer is made ready AFTER the turn is registered: a Stop, a
      // closed window, a workspace switch or a profile quiesce that arrives
      // while it loads reaches this turn (the same races as the runtime load).
      // A tokenizer that cannot be made ready is a refusal to start (fail
      // closed): no audit row exists and the renderer takes its own engine.
      const tokenizerReady = await Promise.race([
        tokenizer.ensureReady().then(
          () => true,
          () => false,
        ),
        forcedRace,
      ]);
      if (turn.forcedCause !== null)
        throw new MastraTurnAborted(turn.forcedCause);
      if (turn.userStop) {
        turn.cancelObserved = true;
        throw new MastraTurnCancelled();
      }
      if (!tokenizerReady) return refusal("unsupported");
      let readBindingsModule: typeof MastraTurnReadBindings | null = null;
      if (request.tools.length > 0) {
        const loaded = await Promise.race([
          loadReadBindings().then(
            (module) => ({ module }),
            () => ({ module: null }),
          ),
          forcedRace,
        ]);
        if (turn.forcedCause !== null)
          throw new MastraTurnAborted(turn.forcedCause);
        if (turn.userStop) {
          turn.cancelObserved = true;
          throw new MastraTurnCancelled();
        }
        if (loaded.module === null) return refusal("unsupported");
        readBindingsModule = loaded.module;
      }
      const runtime = await Promise.race([loadRuntime(), forcedRace]);
      // Stopped or detached while the runtime was loading: no row was written.
      if (turn.forcedCause !== null)
        throw new MastraTurnAborted(turn.forcedCause);
      if (turn.userStop) {
        turn.cancelObserved = true;
        throw new MastraTurnCancelled();
      }
      // Settings and the key are resolved ONCE, here, through the contract's own
      // function (not a copy), before the Agent runs and before any audit row:
      // a run that is known not to be sendable (no key, unreadable settings) is
      // not begun, so no start-only row and no failed provider turn is made for
      // an ordinary user state. The failure is the caller's `ok:false`; it is
      // not logged here (it is not a fault of Main's).
      const credentials = await Promise.race([
        resolveRequiredAiKeyAndSettings(
          backend,
          {
            provider: request.route.provider,
            endpointId: request.route.endpointId,
          },
          { backend, shell: {}, secrets: options.secrets },
          "mastra_agent_turn_start",
        ),
        forcedRace,
      ]);
      // The identity, the profile or a stop may have changed during the await.
      assertLive(turn);
      const turnReadBindings =
        request.tools.length === 0
          ? null
          : await readBindingsModule!.createTurnReadBindings({
              backend: options.backend!,
              identity: callerIdentity as MainIssuedCallerIdentity,
              hooks: readHooksOf(turn),
              request,
              projectId: turn.projectId,
              currentSceneId: turn.currentSceneId,
              tokenizer,
              toolDefinitions,
            });
      const run = runtime.runTurn({
        instructions: split.instructions,
        messages: split.messages,
        route: request.route as unknown as AgentRoute,
        systemCacheSegments: request.systemCacheSegments,
        systemVolatileTail: request.systemVolatileTail,
        send: sendFor(turn, backend, credentials),
        audit: guardedSink(turn),
        assertSendAllowed: async ({ sendIndex }) => {
          assertLive(turn);
          const pending = backend.dbExecute(
            "SELECT ai_policy FROM projects WHERE id = ? LIMIT 1",
            [turn.projectId],
            "get",
            JSON.stringify(turn.identity),
          );
          trackRead(
            turn,
            pending.then(
              () => undefined,
              () => undefined,
            ),
          );
          const rawPolicy = await pending;
          assertLive(turn);
          if (!projectAiChatPolicyAllows(rawPolicy)) {
            turn.cancelObserved = true;
            throw sendIndex === 0
              ? new MastraTurnCancelled()
              : new MastraAgentLoopStopped();
          }
        },
        toolDefinitions,
        bindings: turnReadBindings?.bindings ?? [],
        isToolDeclared: (name) => declaredToolNames.has(name),
        isTurnStopped: () =>
          turn.userStop || turn.forcedCause !== null || turn.finished,
        maxToolCalls: request.loop.maxToolCalls,
        maxUserQuestions: request.loop.maxUserQuestions,
        tokenBudget: request.loop.tokenBudget,
        countTokens: (text) => tokenizer.countTokens(text),
        prepareSend: (auditRequest, ctx) => {
          if (ctx.sendIndex > 0 && turn.userStop)
            throw new MastraAgentLoopStopped();

          let messages = auditRequest.messages;
          const limitReason = getAgentLimitReason(loopState);
          if (limitReason !== null && !loopState.limitMessageInserted) {
            loopState = insertLimitMessage(loopState);
            messages = [
              ...messages,
              {
                role: "user",
                content: selectAgentControlMessage(
                  limitReason,
                  controlMessages,
                ),
              },
            ];
          }
          const tools = loopState.limitMessageInserted
            ? []
            : auditRequest.tools;
          const requestToFinalize: AgentAuditRequest = {
            ...auditRequest,
            messages,
            tools,
          };
          const payloadRoute = {
            provider: request.route.provider,
            apiVariant: request.route.apiVariant,
            toolProtocol:
              requestToFinalize.resolvedToolProtocol ??
              request.route.resolvedToolProtocol ??
              "native",
          };
          const finalized = finalizeTurnPayload(
            {
              route: {
                surface: "agent",
                provider: request.route.provider,
                model,
                apiVariant: request.route.apiVariant,
                toolProtocol: payloadRoute.toolProtocol,
                contextWindow: request.loop.contextWindow,
                wireOutputTokens: request.loop.requestMaxOutputTokens,
              },
              system: {
                fallback: request.loop.fallbackSystem,
                cacheSegments:
                  requestToFinalize.systemCacheSegments === null
                    ? undefined
                    : [...requestToFinalize.systemCacheSegments],
                volatileTail: requestToFinalize.systemVolatileTail ?? undefined,
              },
              messages: requestToFinalize.messages,
              renderedConversationPayloads: renderAgentConversationPayloads(
                payloadRoute,
                requestToFinalize.messages,
              ),
              // The declared tools are counted as the legacy path counts them.
              renderedToolPayloads: renderAgentToolPayloads(
                payloadRoute,
                loopState.limitMessageInserted ? [] : toolDefinitions,
                requestToFinalize.webSearch as Parameters<
                  typeof renderAgentToolPayloads
                >[2],
              ),
              envelopeTokens: 0,
              safetyMarginTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
            },
            // Bound: a `CoreTokenizer` is an interface, and an implementation
            // may keep state on `this`.
            (text) => tokenizer.countTokens(text),
          );
          const preparedRequest: AgentAuditRequest = {
            ...requestToFinalize,
            systemCacheSegments:
              finalized.transport.systemCacheSegments ?? null,
            systemVolatileTail: finalized.transport.systemVolatileTail ?? null,
          };
          declaredToolNames = new Set(
            preparedRequest.tools?.map(({ name }) => name) ?? [],
          );
          progress.send({
            kind: "send-accepted",
            sendIndex: ctx.sendIndex + 1,
            usage: progressUsage(finalized.usage, request.loop.contextWindow),
            cacheDowngradeReason: finalized.cacheDowngradeReason ?? null,
          });
          return preparedRequest;
        },
        observeResponse: (response) => {
          if (response.stopReason === "tool_use") turnReadBindings?.clear();
          const responseText = response.blocks
            .filter((block) => block.type === "text")
            .map((block) => block.content)
            .join("\n");
          finalText += responseText;

          const toolUses =
            response.stopReason === "tool_use"
              ? response.blocks.filter((block) => block.type === "tool_use")
              : [];
          loopState = recordToolUsesForResponse(
            loopState,
            response.stopReason,
            toolUses.map((block) => block.name),
          );
          if (!loopState.limitMessageInserted) {
            for (const block of toolUses) {
              if (toolCallRecordIndexes.has(block.id)) continue;
              toolCallRecordIndexes.set(block.id, toolCallRecords.length);
              toolCallRecords.push({
                name: block.name,
                params: block.input,
                resultSummary: "",
                tokensUsed: 0,
              });
            }
          }

          if (response.inputTokens != null)
            tokensIn = (tokensIn ?? 0) + response.inputTokens;
          if (response.outputTokens != null)
            tokensOut = (tokensOut ?? 0) + response.outputTokens;
          if (response.cost != null) cost = (cost ?? 0) + response.cost;
          for (const citation of response.citations ?? []) {
            if (!citations.some((item) => item.url === citation.url))
              citations.push(citation);
          }
          finalThinkingBlocks = response.blocks.flatMap((block) =>
            block.type === "thinking" &&
            typeof block.signature === "string" &&
            block.signature.length > 0
              ? [{ thinking: block.content, signature: block.signature }]
              : [],
          );
        },
        onToolStart: ({ toolCallId, toolName }) => {
          if (
            turn.forcedCause !== null ||
            turn.finished ||
            startedToolCallIds.has(toolCallId) ||
            !m4Tools.has(toolName)
          ) {
            return;
          }
          startedToolCallIds.add(toolCallId);
          progress.send({
            kind: "tool",
            phase: "started",
            toolCallId,
            toolName: toolName as M4ReadToolName,
            totalCalls: loopState.totalCalls,
            maxCalls: loopState.maxToolCalls,
            tokensUsed: loopState.tokensUsed,
            tokenBudget: loopState.tokenBudget,
          });
        },
        onToolResult: ({ toolCallId, toolName, tokens, summary }) => {
          if (turn.forcedCause !== null || turn.finished) return;
          if (!Number.isSafeInteger(tokens) || tokens < 0) {
            throw new Error("MASTRA_AGENT_TOOL_RESULT_TOKENS_INVALID");
          }
          if (completedToolCallIds.has(toolCallId)) return;
          completedToolCallIds.add(toolCallId);
          loopState = recordToolResultTokens(loopState, tokens);
          const recordIndex = toolCallRecordIndexes.get(toolCallId);
          if (recordIndex !== undefined) {
            const record = toolCallRecords[recordIndex];
            if (record && record.name === toolName) {
              toolCallRecords[recordIndex] = {
                ...record,
                resultSummary: summary,
                tokensUsed: tokens,
              };
            }
          }
          if (m4Tools.has(toolName) && startedToolCallIds.has(toolCallId)) {
            progress.send({
              kind: "tool",
              phase: "finished",
              toolCallId,
              toolName: toolName as M4ReadToolName,
              totalCalls: loopState.totalCalls,
              maxCalls: loopState.maxToolCalls,
              tokensUsed: loopState.tokensUsed,
              tokenBudget: loopState.tokenBudget,
            });
          }
        },
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
        loopResult: makeLoopResult(),
      };
    } catch (error) {
      const overflow = findContextWindowExceeded(error);
      const loopStopped =
        findAgentLoopStopped(error) ||
        (overflow !== null &&
          turn.userStop &&
          turn.handle !== null &&
          turn.response !== null);
      if (loopStopped && turn.forcedCause === null) {
        const { handle, response } = turn;
        if (handle === null || response === null) throw endError(turn, error);
        const completedRecordIndexes = new Set(
          [...completedToolCallIds]
            .map((toolCallId) => toolCallRecordIndexes.get(toolCallId))
            .filter((index): index is number => index !== undefined),
        );
        for (let index = toolCallRecords.length - 1; index >= 0; index -= 1) {
          if (!completedRecordIndexes.has(index))
            toolCallRecords.splice(index, 1);
        }
        loopState = markAgentLoopAborted(loopState);
        if (sendTerminalProgress({ kind: "stopped", reason: "user-stop" })) {
          return {
            status: "completed",
            turnId: turn.turnId,
            executionId: handle.executionId,
            response,
            loopResult: makeLoopResult("aborted"),
          };
        }
      }
      // A Stop wins over an overflow found in the same send's `prepareSend`
      // (it runs before `audit.begin`, so the runtime has not observed the
      // stop yet): it keeps the pre-first-send cancellation, or aggregates a
      // loop that already has a completed response above.
      if (
        overflow &&
        turn.forcedCause === null &&
        turn.userStop &&
        (turn.handle === null || turn.response === null)
      ) {
        turn.cancelObserved = true;
      }
      if (overflow && turn.forcedCause === null && !turn.cancelObserved) {
        const usage = progressUsage(
          overflow.usage,
          request.loop.contextWindow,
          overflow.overflowTokens,
        );
        if (
          !sendTerminalProgress({
            kind: "context-overflow",
            usage,
            overflowTokens: overflow.overflowTokens,
            cacheDowngradeReason: overflow.cacheDowngradeReason,
          })
        ) {
          throw endError(turn, error);
        }
        return {
          status: "context-window-exceeded",
          turnId: turn.turnId,
          usage,
          overflowTokens: overflow.overflowTokens,
        };
      }
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
    open: options.open,
    start: (context, request) => start(context, request),
    cancel: (context, request) => cancel(context, request),

    async quiesceForProfileEgress(context) {
      // Admission first, and for good (a restricted or unavailable profile
      // does not reopen until the process restarts).
      closed ??= "profile";
      const turns = coveredTurns();
      if (turns.length === 0) return;
      const inNative = turns.some((turn) => turn.nativeInFlight > 0);
      const terminals = turns
        .filter(needsAbort)
        .map((turn) => forceAbort(turn, "restricted"));
      // Reserved: Native's own stop request for what is in Native, only when
      // something of ours is (a launch with no turn leaves stage 5 as it was).
      if (inNative) context?.abortNativeInFlight();
      // A terminal that cannot be written fails the quiesce: the activation
      // fails closed (unavailable), the existing path.
      // The reads Native still holds are waited for too, inside the gate's own
      // bound (no timer here): a read that never settles ends as the gate's
      // participant timeout, the same fail-closed end as a terminal that never
      // lands. `Promise.all` keeps a failed terminal failing the quiesce.
      const drains = readDrains(turns);
      profileDrains.add(drains.release);
      try {
        await Promise.all([...terminals, drains.settled]);
      } finally {
        profileDrains.delete(drains.release);
      }
    },

    forceStopForProfileEgress() {
      for (const turn of attachedTurns()) void forceAbort(turn, "restricted");
      // The gate's bound ran out: its wait is over, so the read waiters go too.
      for (const release of [...profileDrains]) release();
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
      const turns = coveredTurns();
      if (turns.length === 0) return lease;
      const terminals = turns
        .filter(needsAbort)
        .map((turn) => forceAbort(turn, "workspace-switch"));
      const drains = readDrains(turns);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const bound = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), forcedBoundMs);
      });
      try {
        const outcome = await Promise.race([
          // One bound for the terminals and the reads Native still holds.
          Promise.allSettled([...terminals, drains.settled]),
          bound,
        ]);
        if (outcome === "timeout") {
          log(
            "warn",
            "main agent turn: terminals or reads not settled within the switch bound",
          );
        }
      } finally {
        drains.release();
        if (timer !== null) clearTimeout(timer);
      }
      return lease;
    },

    shutdown() {
      if (shutdownPromise !== null) return shutdownPromise;
      closed = "quit";
      shutdownPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let drains: ReturnType<typeof readDrains> | null = null;
        try {
          const turns = coveredTurns();
          if (turns.length === 0) return;
          const terminals = turns.filter(needsAbort).map((turn) =>
            forceAbort(turn, "quit").then(
              () => undefined,
              () => undefined,
            ),
          );
          drains = readDrains(turns);
          const bound = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, quitBoundMs);
          });
          // One bound for the terminals and the reads Native still holds.
          await Promise.race([
            Promise.all([...terminals, drains.settled]),
            bound,
          ]);
        } catch {
          // Bounded and never rejecting: a failure leaves a start-only row, which the report counts.
        } finally {
          drains?.release();
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
    readHooks(turnId) {
      const turn = attached.get(turnId);
      return turn === undefined ? null : readHooksOf(turn);
    },
    readsInFlight() {
      let count = 0;
      for (const turn of readTurns) count += turn.readInFlight;
      return count;
    },
  };
}
