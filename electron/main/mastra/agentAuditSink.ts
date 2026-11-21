/**
 * The audit writer of the Mastra agent turn: Electron main appends the rows
 * itself (MP-3b, DR-MP3-23; audit owner `main-agent`).
 *
 * It implements the adapter's `AgentAuditSink` (`agentWire.ts`) and writes
 * through the existing `ai_audit_append_batch`, with the same checks the
 * renderer's batches pass (`runAiAuditAppendBatch`). The path ID stays
 * `chat_agent_main`: a new path ID or event type is not made, so the capability
 * issue conditions, the model routing and the journey's SQL, which depend on the
 * path ID, are unchanged. The owner is told apart by the registry's extra owner
 * field (`aiPathRegistry.ts`); a row itself carries no owner label (its
 * `dispatchBoundary` and `transportTarget` already tell a main-written row from
 * a renderer-written one).
 *
 * What it writes, in order, for one execution (the Rust side requires the three
 * rows of a dispatch to be durable, in this order, before it sends):
 *   1. `begin`: one batch of `execution.started` and `request.prepared`, awaited;
 *   2. `dispatched`: one batch of `request.dispatched`, awaited;
 *   3. one terminal batch: `complete`, `fail`, or an ambiguous terminal.
 * The execution ID is Main's (the sink issues it); the parent is `null` (tool 0:
 * there is no child call); the sink holds no capability and never writes one; and
 * it holds no reference to the send: a failed append is re-sent only as the same
 * batch with the same event IDs (the audit's idempotency key), never as a
 * provider request.
 *
 * Each execution gets one terminal. A second terminal call for the execution
 * (for example the owner's ambiguous terminal after the adapter's own, or the
 * reverse) waits for one in flight and writes nothing if it was written. If the
 * terminal in flight failed, the waiting call writes its own, so a failed
 * `complete` does not leave the execution start-only behind an ambiguous call.
 * A request to stop (any terminal call) is remembered for good: the execution
 * is never dispatched afterwards, even if that terminal's append failed.
 *
 * An ambiguous terminal (DR-MP3-10) is not a new event type: it is the
 * `execution.failed` (or `execution.cancelled`) row with the payload
 * `remoteOutcome: "unknown"`, `conservative: true`, `captureState: "partial"`
 * and `responseObserved: false`. It says that Main cannot tell whether the
 * provider received the request.
 */
import {
  buildAiAuditBeginEvents,
  buildAiAuditCancelledEvents,
  buildAiAuditCompletedEvents,
  buildAiAuditDispatchedEvent,
  buildAiAuditFailedEvents,
  sanitizeAiAuditDiagnostic,
  sanitizedErrorSnapshot,
  type AiAuditCaptureState,
  type AiAuditEventContext,
  type AiAuditEventInput,
  type AiAuditJsonObject,
  type AiAuditJsonValue,
} from "../../shared/aiAuditEvents.js";
import {
  runAiAuditAppendBatch,
  type NapiBackendLike,
} from "../../shared/ipcContract.js";
import { isAgentModelError, type AgentModelError } from "./agentModelPolicy.js";
import type {
  AgentAuditCompletion,
  AgentAuditHandle,
  AgentAuditRequest,
  AgentAuditSink,
  AgentNativeAuditContext,
} from "./agentWire.js";

/** The path ID of the main chat agent. It is not changed for this owner. */
export const MAIN_AGENT_AUDIT_PATH_ID = "chat_agent_main";
/** The audit owner of this writer (`AiAuditOwner` in `aiPathRegistry.ts`). */
export const MAIN_AGENT_AUDIT_OWNER = "main-agent";

/** Why a turn ended without an observed provider outcome (DR-MP3-6). */
export type MainAgentAmbiguousCause =
  | "restricted"
  | "workspace-switch"
  | "quit"
  | "sender-gone"
  | "unknown";

export interface MainAgentAuditHandle extends AgentAuditHandle {
  readonly executionId: string;
  readonly operationId: string;
  readonly startedAt: number;
}

export interface MainAgentAuditSink extends AgentAuditSink<MainAgentAuditHandle> {
  /**
   * The terminal of an execution the user stopped before Main's send to Native (the dispatch row may already be written)
   * (`execution.cancelled`, with no ambiguous mark: nothing was sent, so the
   * outcome is known). It is the one terminal of the execution like the others.
   */
  cancel(
    handle: MainAgentAuditHandle,
    input: { readonly reason: "user-stop" },
  ): Promise<void>;
  /**
   * The ambiguous terminal of an execution Main cannot close with an observed
   * outcome (a forced abort, a switch, a quit, a gone sender). `failed` for a
   * stop Main made, `cancelled` for one the user asked for.
   */
  ambiguous(
    handle: MainAgentAuditHandle,
    input: {
      readonly cause: MainAgentAmbiguousCause;
      readonly kind?: "failed" | "cancelled";
    },
  ): Promise<void>;
}

export interface MainAgentAuditSinkOptions {
  readonly backend: Pick<NapiBackendLike, "aiAuditAppendBatch">;
  /** `app.getVersion()` (the renderer reads `package.json`; the two agree). */
  readonly appVersion: string;
  /** The turn's project (`null` records in the workspace chain). */
  readonly projectId: string | null;
  /** The workspace the turn was admitted under; Native compares it with the active one. */
  readonly expectedWorkspacePath: string;
  /** One per turn; defaults to a fresh UUID. */
  readonly operationId?: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

function jsonObject(value: unknown): AiAuditJsonObject {
  return value as AiAuditJsonObject;
}

/**
 * The request snapshot of a begin: the model-visible request as the adapter
 * built it, allow-listed like the renderer's `auditRequestFromChatArgs`, so a
 * credential or a future transport-only field cannot enter the log by
 * accident. The route is the renderer's snapshot that crossed the turn wire:
 * Native resolves the effective one later, so the begin is `partial` with the
 * same limitation the renderer states for an unresolved route.
 */
function requestSnapshot(request: AgentAuditRequest): {
  readonly request: AiAuditJsonObject;
  readonly captureState: AiAuditCaptureState;
  readonly limitations: readonly string[];
} {
  const source = request as unknown as Readonly<Record<string, unknown>>;
  const pick = (keys: readonly string[]): AiAuditJsonObject => {
    const picked: Record<string, AiAuditJsonValue> = {};
    for (const key of keys) {
      if (source[key] !== undefined) {
        picked[key] = source[key] as AiAuditJsonValue;
      }
    }
    return picked;
  };
  const options = pick([
    "thinking",
    "effort",
    "reasoningEnabled",
    "reasoningEffort",
    "apiVariant",
    "endpointId",
    "requestMaxOutputTokens",
    "resolvedToolProtocol",
    "webSearch",
  ]);
  const modelVisibleContext = pick([
    "systemCacheSegments",
    "systemVolatileTail",
  ]);
  const provider = typeof source.provider === "string" ? source.provider : null;
  const model = typeof source.model === "string" ? source.model : null;
  const limitations = ["effective-route-unresolved-before-transport"];
  return {
    captureState: "partial",
    limitations,
    request: {
      messages: (Array.isArray(source.messages)
        ? source.messages
        : []) as AiAuditJsonValue,
      ...(provider !== null ? { provider } : {}),
      ...(model !== null ? { model } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
      ...(Object.keys(modelVisibleContext).length > 0
        ? { modelVisibleContext }
        : {}),
      ...(Array.isArray(source.tools)
        ? { tools: source.tools as AiAuditJsonValue }
        : {}),
      auditMetadata: {
        routeObservation: {
          captureState: "partial",
          requestedProvider: provider,
          requestedModel: model,
          authority: "unknown",
          transportEffectiveRouteObserved: false,
          transportResolutionLimitations: limitations,
          resolutionBoundary: "main_agent_turn_wire",
        },
      },
    },
  };
}

export function createMainAgentAuditSink(
  options: MainAgentAuditSinkOptions,
): MainAgentAuditSink {
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const operationId = options.operationId ?? randomUUID();
  /**
   * executionIds for which a terminal was ever requested. Never released: an
   * execution that was asked to stop does not go on to dispatch, whatever the
   * terminal's append did.
   */
  const stopped = new Set<string>();
  /** executionIds whose terminal is durable (one each). */
  const written = new Set<string>();
  /** The terminal append in flight, per execution; it settles to whether it succeeded. */
  const pending = new Map<string, Promise<boolean>>();
  /** executionIds whose begin batch is durable and whose dispatch is not yet written. */
  const dispatchable = new Set<string>();

  const contextOf = (handle: MainAgentAuditHandle): AiAuditEventContext => ({
    executionId: handle.executionId,
    operationId: handle.operationId,
    parentExecutionId: handle.auditContext.parentExecutionId,
    pathId: handle.auditContext.pathId,
    appVersion: options.appVersion,
  });

  /**
   * One batch through the contract's checks. A failure is re-sent once, as the
   * same batch with the same event IDs: if the first call committed and only
   * lost its reply, the audit's idempotency key makes the re-send a no-op. It is
   * the append that is re-sent; nothing here can reach the send.
   */
  async function append(
    handle: MainAgentAuditHandle,
    events: readonly AiAuditEventInput[],
  ): Promise<void> {
    const args = {
      expectedWorkspacePath: handle.auditContext.expectedWorkspacePath,
      projectId: handle.auditContext.projectId,
      events,
    };
    try {
      await runAiAuditAppendBatch(options.backend, args);
    } catch {
      await runAiAuditAppendBatch(options.backend, args);
    }
  }

  /**
   * Writes the terminal batch once. A caller that finds a terminal in flight
   * waits for its result: if it was written there is nothing to add, and if its
   * append failed this caller writes its own (so a failed `complete` cannot
   * leave an execution start-only behind an ambiguous call that returned early).
   * The claim is taken synchronously, so only one writer is ever in flight.
   */
  async function terminal(
    handle: MainAgentAuditHandle,
    build: () => Promise<readonly AiAuditEventInput[]>,
  ): Promise<void> {
    const id = handle.executionId;
    stopped.add(id);
    dispatchable.delete(id);
    for (;;) {
      if (written.has(id)) return;
      const inFlight = pending.get(id);
      if (inFlight !== undefined) {
        await inFlight;
        continue;
      }
      let failure: unknown;
      const attempt = (async (): Promise<boolean> => {
        try {
          await append(handle, await build());
          written.add(id);
          return true;
        } catch (error) {
          failure = error;
          return false;
        } finally {
          pending.delete(id);
        }
      })();
      pending.set(id, attempt);
      // The attempt awaits `build()` first, so its `finally` cannot run before
      // this set.
      if (!(await attempt)) throw failure;
      return;
    }
  }

  return {
    async begin(request) {
      const snapshot = requestSnapshot(request);
      const executionId = randomUUID();
      const startedAt = now();
      const auditContext: AgentNativeAuditContext = {
        expectedWorkspacePath: options.expectedWorkspacePath,
        projectId: options.projectId,
        operationId,
        executionId,
        parentExecutionId: null,
        pathId: MAIN_AGENT_AUDIT_PATH_ID,
      };
      const handle: MainAgentAuditHandle = {
        auditContext,
        executionId,
        operationId,
        startedAt,
      };
      await append(
        handle,
        buildAiAuditBeginEvents(
          contextOf(handle),
          {
            captureState: snapshot.captureState,
            limitations: snapshot.limitations,
            request: snapshot.request,
          },
          startedAt,
        ),
      );
      dispatchable.add(executionId);
      return handle;
    },

    async dispatched(handle) {
      // After a terminal (a forced abort) nothing is dispatched: the throw
      // reaches the adapter before the send.
      if (stopped.has(handle.executionId)) {
        throw new Error("AGENT_AUDIT_TERMINAL_ALREADY_WRITTEN");
      }
      if (!dispatchable.has(handle.executionId)) {
        throw new Error("AGENT_AUDIT_NOT_BEGUN");
      }
      await append(handle, [
        buildAiAuditDispatchedEvent(
          contextOf(handle),
          {
            command: "send_agent_message",
            runtimeTarget: "electron",
            dispatchBoundary: "before_electron_main_native_send",
            transportTarget: "electron-main-native",
            providerReceiptObserved: false,
            modelDispatched: null,
          },
          now(),
        ),
      ]);
      // A stop requested while the append was in flight (a forced abort): the
      // send must not follow, whatever the terminal's own append does.
      if (stopped.has(handle.executionId)) {
        throw new Error("AGENT_AUDIT_TERMINAL_ALREADY_WRITTEN");
      }
      dispatchable.delete(handle.executionId);
    },

    async complete(handle, completion: AgentAuditCompletion) {
      // A capability (a bearer) is never a row. The adapter already omits it;
      // this is the second line, by name.
      const { agentAuthorityCapabilities: _capabilities, ...response } =
        completion.response as AgentAuditCompletion["response"] & {
          agentAuthorityCapabilities?: unknown;
        };
      await terminal(handle, async () =>
        buildAiAuditCompletedEvents(
          contextOf(handle),
          {
            response: jsonObject(response),
            usage: jsonObject(completion.usage),
          },
          now(),
        ),
      );
    },

    async fail(handle, error) {
      // The adapter wraps a send's failure in its own error; the audit records
      // the cause (the adapter's kind is kept as metadata).
      const wrapped: AgentModelError | null = isAgentModelError(error)
        ? error
        : null;
      const cause =
        wrapped !== null && wrapped.origin !== undefined
          ? wrapped.origin
          : error;
      const failedAt = now();
      await terminal(handle, async () =>
        buildAiAuditFailedEvents(
          contextOf(handle),
          await sanitizedErrorSnapshot(cause),
          {
            ...(wrapped === null
              ? {}
              : { metadata: { agentErrorKind: wrapped.kind } }),
          },
          failedAt,
        ),
      );
    },

    async cancel(handle, input) {
      const at = now();
      await terminal(handle, async () =>
        buildAiAuditCancelledEvents(
          contextOf(handle),
          await sanitizeAiAuditDiagnostic(
            `main agent turn stopped by the user before the send to Native: ${input.reason}`,
            "reason",
          ),
          {},
          at,
        ),
      );
    },

    async ambiguous(handle, input) {
      const at = now();
      await terminal(handle, async () => {
        const marker = {
          remoteOutcome: "unknown",
          conservative: true,
          captureState: "partial",
          responseObserved: false,
        } as const;
        const message = `main agent turn ended without an observed provider outcome: ${input.cause}`;
        const events =
          input.kind === "cancelled"
            ? buildAiAuditCancelledEvents(
                contextOf(handle),
                await sanitizeAiAuditDiagnostic(message, "reason"),
                {},
                at,
              )
            : buildAiAuditFailedEvents(
                contextOf(handle),
                await sanitizedErrorSnapshot(
                  Object.assign(new Error(message), {
                    name: "AgentTurnAmbiguousOutcome",
                  }),
                ),
                {},
                at,
              );
        const last = events.length - 1;
        // The marks go before `appVersion`, which stays the payload's last key.
        return events.map((event, index) => {
          if (index !== last) return event;
          const { appVersion, ...rest } = event.payload;
          return {
            ...event,
            payload: { ...rest, ...marker, appVersion },
          } as AiAuditEventInput;
        });
      });
    },
  };
}
