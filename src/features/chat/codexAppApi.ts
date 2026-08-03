import { invoke, listen } from "@/lib/tauri";
import * as cliApi from "./cliApi";
import {
  attemptAiAuditPersistenceFailureTerminal,
  beginAiAuditExecutionInWorkspace,
  cancelAiAuditExecution,
  completeAiAuditExecution,
  failAiAuditExecution,
  fallbackAiAuditExecution,
  markAiAuditDispatched,
  recordAiAuditPartials,
  sanitizeAiAuditDiagnostic,
  type AiAuditPartialInput,
} from "@/features/ai-audit/api";
import { createOrderedStreamAuditBatchQueue } from "@/features/ai-audit/orderedStreamAudit";
import {
  auditErrorSnapshot,
  beforeIpcDispatchDetails,
  nativeAiAuditContext,
} from "@/features/ai-audit/transportContext";
import type {
  AiAuditExecutionHandle,
  AiAuditJsonObject,
  AiAuditRequestSnapshot,
} from "@/features/ai-audit/types";
import { CODEX_APP_SERVER_WORKSPACE_STALE_CODE } from "@/../electron/shared/codexAppProtocol";
import type {
  ArchiveCodexSessionThreadPayload,
  AdvanceCodexHistoryRevisionPayload,
  AdvanceCodexHistoryRevisionResult,
  CodexAppEventEnvelope,
  CodexAppItem,
  CodexModel,
  InterruptCodexAppTurnPayload,
  SetCodexThreadNamePayload,
  StartCodexAppTurnPayload,
  StartCodexAppTurnResult,
} from "@/../electron/shared/codexAppProtocol";

export type { CodexAppItem } from "@/../electron/shared/codexAppProtocol";

export interface CodexAppStreamCallbacks {
  onTextDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onDone: (info: {
    stopReason: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  }) => void;
  onError: (message: string) => void;
  onItemStarted?: (item: CodexAppItem) => void;
  onItemCompleted?: (item: CodexAppItem) => void;
  onTurnStarted?: (ids: { threadId?: string; turnId?: string }) => void;
  onFallback?: () => void;
  onApprovalRequested?: (
    event: Extract<
      CodexAppEventEnvelope["event"],
      { type: "approval-requested" }
    >,
  ) => void;
  onWarning?: (message: string) => void;
}

export interface CodexAppTurnPayload extends Omit<
  StartCodexAppTurnPayload,
  "auditContext"
> {
  transport?: "app-server" | "auto";
  fallbackCli?: cliApi.CliChatPayload;
}

type CodexAuditPartialItem =
  | {
      readonly kind: "observed";
      readonly receivedAt: number;
      readonly response: AiAuditJsonObject;
    }
  | {
      readonly kind: "diagnostic";
      readonly receivedAt: number;
      readonly sequence: number;
      readonly phase: string;
      readonly message: string;
      readonly code: string | null;
    };

function isEnvelope(value: unknown): value is CodexAppEventEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.projectId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.grimodexTurnId === "string" &&
    typeof record.event === "object" &&
    record.event !== null
  );
}

function isStartTurnResult(value: unknown): value is StartCodexAppTurnResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.status === "started") {
    return (
      typeof record.codexThreadId === "string" &&
      record.codexThreadId.length > 0 &&
      typeof record.codexTurnId === "string" &&
      record.codexTurnId.length > 0 &&
      typeof record.reusedThread === "boolean"
    );
  }
  return (
    record.status === "rejected-before-turn" &&
    typeof record.code === "string" &&
    record.code.length > 0 &&
    typeof record.message === "string" &&
    record.message.length > 0
  );
}

function isCancelledCodexStopReason(stopReason: string): boolean {
  return ["interrupted", "stopped", "cancelled", "canceled"].includes(
    stopReason.trim().toLowerCase(),
  );
}

export function codexAppAuditRequest(
  payload: StartCodexAppTurnPayload,
): AiAuditRequestSnapshot {
  return {
    provider: "cli",
    ...(payload.model ? { model: payload.model } : {}),
    messages: [],
    options: {
      runtime: "codex-app-server",
      effort: payload.effort ?? null,
    },
    auditMetadata: {
      runtimeObservation: {
        captureState: "partial",
        effectiveRequestReceiptPending: true,
        externalRuntimeInternalPromptObserved: false,
        providerPrivateThinkingObserved: false,
      },
      correlation: {
        sessionId: payload.sessionId,
        grimodexTurnId: payload.grimodexTurnId,
        clientUserMessageId: payload.clientUserMessageId,
      },
      historyRevision: payload.historyRevision,
    },
  };
}

/** Adapt normalized main-process events to the existing ChatStore stream callbacks. */
export async function sendCodexAppTurn(
  payload: CodexAppTurnPayload,
  callbacks: CodexAppStreamCallbacks,
): Promise<() => void> {
  const { transport, fallbackCli, ...rendererRequestPayload } = payload;
  let audit: AiAuditExecutionHandle = await beginAiAuditExecutionInWorkspace(
    {
      projectId: payload.projectId,
      pathId: "codex_app_server",
      operationId: payload.grimodexTurnId,
      request: codexAppAuditRequest(rendererRequestPayload),
      captureState: "partial",
      limitations: [
        "renderer-intent-awaiting-main-effective-request-receipt",
        "external-runtime-internal-prompt-unobservable",
        "provider-private-thinking-unobservable",
        "audit-storage-failure-may-prevent-recovery-terminal",
        "renderer-cleanup-returns-before-cancel-audit-is-durable",
        "hard-process-kill-may-leave-dispatched-without-terminal",
      ],
      metadata: {
        transport: transport ?? "app-server",
        externalRuntimeInternalPromptObserved: false,
        historyRevision: payload.historyRevision,
        correlation: {
          sessionId: payload.sessionId,
          grimodexTurnId: payload.grimodexTurnId,
          clientUserMessageId: payload.clientUserMessageId,
        },
      },
    },
    payload.expectedWorkspacePath,
  );
  const requestPayload: StartCodexAppTurnPayload = {
    ...rendererRequestPayload,
    auditContext: nativeAiAuditContext(
      audit,
    ) as StartCodexAppTurnPayload["auditContext"],
  };
  let auditTerminal = false;
  let settled = false;
  let uiActive = true;
  let started = false;
  // cleanup can win the race with the long-running start_turn invoke. In that
  // case the main process may only learn the authoritative Codex turn id after
  // the renderer has stopped listening, so issue a second, late interrupt once
  // start_turn resolves.
  let cancelledBeforeStartResolved = false;
  let interruptCommand: Promise<boolean> | null = null;
  let authoritativeInterruptSent = false;
  let fallbackCleanup: (() => void) | null = null;
  let text = "";
  let thinking = "";
  let streamSequence = 0;
  const observableEvents: AiAuditJsonObject[] = [];
  const warnings: string[] = [];
  const approvals: AiAuditJsonObject[] = [];
  let latestUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  } = {};
  const partialResponse = (): AiAuditJsonObject => ({
    text,
    thinking,
    observableEvents,
    warnings,
    approvals,
  });
  const requestInterrupt = (force = false): Promise<boolean> => {
    if (force || interruptCommand === null) {
      interruptCommand = abortCodexAppTurn({
        projectId: payload.projectId,
        sessionId: payload.sessionId,
        grimodexTurnId: payload.grimodexTurnId,
      }).then(
        () => true,
        () => false,
      );
    }
    return interruptCommand;
  };
  const interruptAfterActiveProof = (): void => {
    if (!cancelledBeforeStartResolved || authoritativeInterruptSent) return;
    authoritativeInterruptSent = true;
    void requestInterrupt(true);
  };
  let auditErrorDelivered = false;
  const reportAuditFailure = (error: unknown): void => {
    if (auditErrorDelivered) return;
    const deliverToUi = uiActive;
    auditErrorDelivered = true;
    settled = true;
    uiActive = false;
    unlisten();
    void abortCodexAppTurn({
      projectId: payload.projectId,
      sessionId: payload.sessionId,
      grimodexTurnId: payload.grimodexTurnId,
    }).catch(() => {});
    void attemptAiAuditPersistenceFailureTerminal(audit, {
      persistenceError: error,
      partialResponse: partialResponse(),
      metadata: {
        transport: "codex-app-server",
        transportAbortRequested: true,
        terminalRecoveryBypassedFailedQueue: true,
      },
    });
    if (deliverToUi) {
      callbacks.onError(
        `AI audit persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  let unlisten: () => void = () => {};
  const auditQueue = createOrderedStreamAuditBatchQueue<CodexAuditPartialItem>({
    onPersistenceFailure: reportAuditFailure,
    persistBatch: async (items) => {
      const partials: AiAuditPartialInput[] = [];
      for (const item of items) {
        if (item.kind === "observed") {
          partials.push({
            receivedAt: item.receivedAt,
            response: item.response,
          });
          continue;
        }
        const sanitizedMessage = await sanitizeAiAuditDiagnostic(
          item.message,
          `response.partial.${item.sequence}.diagnostic.message`,
        );
        const sanitizedCode =
          item.code === null
            ? null
            : await sanitizeAiAuditDiagnostic(
                item.code,
                `response.partial.${item.sequence}.diagnostic.code`,
              );
        warnings.push(sanitizedMessage.value);
        const runtimeEvent: AiAuditJsonObject = {
          phase: item.phase,
          message: sanitizedMessage.value,
          code: sanitizedCode?.value ?? null,
        };
        observableEvents.push(runtimeEvent);
        const redactions = [
          ...sanitizedMessage.redactions,
          ...(sanitizedCode?.redactions ?? []),
        ];
        partials.push({
          receivedAt: item.receivedAt,
          response: {
            streamSequence: item.sequence,
            runtimeDiagnostic: runtimeEvent,
          },
          captureState: redactions.length === 0 ? "complete" : "redacted",
          redactions,
        });
      }
      await recordAiAuditPartials(audit, partials);
    },
  });
  const enqueueRuntimeEvent = (
    runtimeEvent: AiAuditJsonObject,
    afterPersisted?: () => void,
  ): void => {
    streamSequence += 1;
    const sequence = streamSequence;
    observableEvents.push(runtimeEvent);
    auditQueue.enqueue(
      {
        kind: "observed",
        receivedAt: Date.now(),
        response: {
          streamSequence: sequence,
          runtimeEvent,
        },
      },
      () => {
        if (uiActive) afterPersisted?.();
      },
    );
  };
  const enqueueDiagnostic = (
    phase: string,
    message: string,
    code: string | null,
    afterPersisted?: () => void,
  ): void => {
    streamSequence += 1;
    const sequence = streamSequence;
    auditQueue.enqueue(
      {
        kind: "diagnostic",
        receivedAt: Date.now(),
        sequence,
        phase,
        message,
        code,
      },
      () => {
        if (uiActive) afterPersisted?.();
      },
    );
  };
  try {
    unlisten = await listen<unknown>("codex-app:event", (raw) => {
      if (settled || !isEnvelope(raw)) return;
      if (
        raw.projectId !== payload.projectId ||
        raw.sessionId !== payload.sessionId ||
        raw.grimodexTurnId !== payload.grimodexTurnId
      ) {
        return;
      }
      const event = raw.event;
      switch (event.type) {
        case "thread-started":
          enqueueRuntimeEvent(
            {
              phase: "thread-started",
              threadId: event.threadId,
            },
            () => callbacks.onTurnStarted?.({ threadId: event.threadId }),
          );
          return;
        case "turn-started":
          started = true;
          interruptAfterActiveProof();
          enqueueRuntimeEvent(
            {
              phase: "turn-started",
              turnId: raw.codexTurnId ?? event.turnId,
            },
            () =>
              callbacks.onTurnStarted?.({
                turnId: raw.codexTurnId ?? event.turnId,
              }),
          );
          return;
        case "text-delta": {
          started = true;
          interruptAfterActiveProof();
          text += event.delta;
          streamSequence += 1;
          const sequence = streamSequence;
          auditQueue.enqueue(
            {
              kind: "observed",
              receivedAt: Date.now(),
              response: {
                streamSequence: sequence,
                blockType: "text",
                delta: event.delta,
              },
            },
            () => {
              if (uiActive) callbacks.onTextDelta(event.delta);
            },
          );
          return;
        }
        case "thinking-delta": {
          started = true;
          interruptAfterActiveProof();
          thinking += event.delta;
          streamSequence += 1;
          const sequence = streamSequence;
          auditQueue.enqueue(
            {
              kind: "observed",
              receivedAt: Date.now(),
              response: {
                streamSequence: sequence,
                blockType: "thinking",
                delta: event.delta,
              },
            },
            () => {
              if (uiActive) callbacks.onThinkingDelta(event.delta);
            },
          );
          return;
        }
        case "item-started":
          started = true;
          interruptAfterActiveProof();
          enqueueRuntimeEvent(
            {
              phase: "item-started",
              item: event.item as unknown as AiAuditJsonObject,
            },
            () => callbacks.onItemStarted?.(event.item),
          );
          return;
        case "item-completed":
          started = true;
          interruptAfterActiveProof();
          enqueueRuntimeEvent(
            {
              phase: "item-completed",
              item: event.item as unknown as AiAuditJsonObject,
            },
            () => callbacks.onItemCompleted?.(event.item),
          );
          return;
        case "usage":
          latestUsage = {
            inputTokens: event.inputTokens ?? latestUsage.inputTokens,
            outputTokens: event.outputTokens ?? latestUsage.outputTokens,
            cacheReadTokens:
              event.cachedInputTokens ?? latestUsage.cacheReadTokens,
          };
          enqueueRuntimeEvent({
            phase: "usage",
            inputTokens: latestUsage.inputTokens ?? null,
            outputTokens: latestUsage.outputTokens ?? null,
            cacheReadTokens: latestUsage.cacheReadTokens ?? null,
          });
          return;
        case "approval-requested":
          // A server request proves that the App Server turn is already active.
          // Falling back to `codex exec` after this point could execute the same
          // request twice while the original turn is still waiting for approval.
          started = true;
          interruptAfterActiveProof();
          approvals.push(event as unknown as AiAuditJsonObject);
          enqueueRuntimeEvent(
            {
              phase: "approval-requested",
              event: event as unknown as AiAuditJsonObject,
            },
            () => callbacks.onApprovalRequested?.(event),
          );
          return;
        case "warning":
          enqueueDiagnostic("warning", event.message, null, () =>
            callbacks.onWarning?.(event.message),
          );
          return;
        case "turn-completed":
          settled = true;
          auditTerminal = true;
          auditQueue.close(
            async () => {
              const abortCommandAcknowledged = cancelledBeforeStartResolved
                ? await requestInterrupt()
                : false;
              if (isCancelledCodexStopReason(event.stopReason)) {
                await cancelAiAuditExecution(audit, {
                  reason: event.stopReason,
                  partialResponse: partialResponse(),
                  metadata: {
                    transportAbortRequested: cancelledBeforeStartResolved,
                    abortCommandAcknowledged,
                    transportTerminationObserved: true,
                    providerAbortReceiptObserved: false,
                    ...(cancelledBeforeStartResolved
                      ? {
                          uiDeliveryEnded: true,
                          auditObservationContinuedUntilTransportTerminal: true,
                          cleanupReturnedBeforeTerminalAuditDurable: true,
                        }
                      : {}),
                  },
                });
                return;
              }
              await completeAiAuditExecution(audit, {
                response: {
                  ...partialResponse(),
                  stopReason: event.stopReason,
                },
                usage: {
                  inputTokens:
                    event.inputTokens ?? latestUsage.inputTokens ?? null,
                  outputTokens:
                    event.outputTokens ?? latestUsage.outputTokens ?? null,
                  cacheReadTokens: latestUsage.cacheReadTokens ?? null,
                  stopReason: event.stopReason,
                },
                metadata: {
                  externalRuntimeInternalPromptObserved: false,
                  ...(cancelledBeforeStartResolved
                    ? {
                        transportAbortRequested: true,
                        abortCommandAcknowledged,
                        transportTerminationObserved: true,
                        providerAbortReceiptObserved: false,
                        uiDeliveryEnded: true,
                        auditObservationContinuedUntilTransportTerminal: true,
                        cleanupReturnedBeforeTerminalAuditDurable: true,
                        abortRacedWithProviderCompletion: true,
                      }
                    : {}),
                },
              });
            },
            () => {
              unlisten();
              if (uiActive) {
                callbacks.onDone({
                  stopReason: event.stopReason,
                  inputTokens: event.inputTokens ?? latestUsage.inputTokens,
                  outputTokens: event.outputTokens ?? latestUsage.outputTokens,
                  cacheReadTokens:
                    latestUsage.cacheReadTokens !== undefined
                      ? latestUsage.cacheReadTokens
                      : undefined,
                });
              }
            },
          );
          return;
        case "turn-error":
          if (event.retryable === true) {
            // Codex may emit a transient error before retrying the same turn. Keep
            // the correlated listener alive and surface it as a warning; a later
            // turn-completed or non-retryable error remains authoritative.
            started = true;
            enqueueDiagnostic(
              "retryable-error",
              event.message,
              event.code ?? null,
              () => callbacks.onWarning?.(event.message),
            );
            return;
          }
          settled = true;
          auditTerminal = true;
          auditQueue.close(
            async () => {
              const abortCommandAcknowledged = cancelledBeforeStartResolved
                ? await requestInterrupt()
                : false;
              await failAiAuditExecution(audit, {
                error: {
                  name: "CodexAppError",
                  message: event.message,
                  ...(event.code ? { code: event.code } : {}),
                },
                partialResponse: partialResponse(),
                metadata: {
                  externalRuntimeInternalPromptObserved: false,
                  ...(cancelledBeforeStartResolved
                    ? {
                        transportAbortRequested: true,
                        abortCommandAcknowledged,
                        transportTerminationObserved: true,
                        providerAbortReceiptObserved: false,
                        uiDeliveryEnded: true,
                        auditObservationContinuedUntilTransportTerminal: true,
                        cleanupReturnedBeforeTerminalAuditDurable: true,
                        abortRacedWithProviderFailure: true,
                      }
                    : {}),
                },
              });
            },
            () => {
              unlisten();
              if (uiActive) callbacks.onError(event.message);
            },
          );
          return;
      }
    });
  } catch (error) {
    await failAiAuditExecution(audit, {
      error: auditErrorSnapshot(error),
      metadata: { phase: "listener-setup", providerDispatched: false },
    });
    throw error;
  }

  try {
    await markAiAuditDispatched(
      audit,
      beforeIpcDispatchDetails("codex_app_start_turn"),
    );
  } catch (error) {
    unlisten();
    throw error;
  }

  const cleanup = (): void => {
    if (!settled) cancelledBeforeStartResolved = true;
    uiActive = false;
    fallbackCleanup?.();
    fallbackCleanup = null;
    if (!settled && !auditTerminal) {
      if (started) authoritativeInterruptSent = true;
      void requestInterrupt();
    }
  };

  const startFallback = (fallbackCli: cliApi.CliChatPayload): void => {
    unlisten();
    if (settled || !uiActive) return;
    auditTerminal = true;
    auditQueue.close(
      async () => {
        audit = await fallbackAiAuditExecution(audit, {
          request: cliApi.cliAuditRequest(fallbackCli),
          reason: "codex-app-rejected-before-turn",
          pathId: "codex_app_cli_fallback",
          metadata: { externalRuntimeInternalPromptObserved: false },
          captureState: "partial",
          limitations: [
            "external-runtime-internal-prompt-unobservable",
            "provider-private-thinking-unobservable",
            "renderer-cleanup-returns-before-cancel-audit-is-durable",
            "hard-process-kill-may-leave-dispatched-without-terminal",
          ],
        });
        if (settled || !uiActive || cancelledBeforeStartResolved) {
          settled = true;
          await cancelAiAuditExecution(audit, {
            reason: "fallback-cancelled-before-dispatch",
            metadata: {
              modelDispatched: false,
              transportAbortRequested: false,
              abortCommandAcknowledged: false,
              transportTerminationObserved: false,
              providerAbortReceiptObserved: false,
              uiDeliveryEnded: true,
              cleanupReturnedBeforeTerminalAuditDurable: true,
            },
          });
        }
      },
      () => {
        if (settled || !uiActive) return;
        callbacks.onFallback?.();
        void cliApi
          .sendCliChatStream(
            fallbackCli,
            {
              projectId: payload.projectId,
              pathId: "codex_app_cli_fallback",
              operationId: payload.grimodexTurnId,
              parentExecutionId: audit.parentExecutionId,
            },
            callbacks,
            audit,
          )
          .then((resolvedFallbackCleanup) => {
            if (settled || !uiActive) {
              resolvedFallbackCleanup();
              return;
            }
            fallbackCleanup = resolvedFallbackCleanup;
          })
          .catch((fallbackCause: unknown) => {
            if (settled || !uiActive) return;
            settled = true;
            callbacks.onError(
              fallbackCause instanceof Error
                ? fallbackCause.message
                : String(fallbackCause),
            );
          });
      },
    );
  };

  const failUnknownStartOutcome = (message: string, code: string): void => {
    if (settled || auditTerminal) return;
    const deliverToUi = uiActive;
    settled = true;
    auditTerminal = true;
    cancelledBeforeStartResolved = true;
    auditQueue.close(
      async () => {
        const abortCommandAcknowledged = await requestInterrupt();
        await failAiAuditExecution(audit, {
          error: {
            name: "CodexAppStartOutcomeUnknown",
            message,
            code,
          },
          partialResponse: partialResponse(),
          metadata: {
            providerOutcomeUnknown: true,
            modelDispatched: null,
            transportAbortRequested: true,
            abortCommandAcknowledged,
            transportTerminationObserved: false,
            providerAbortReceiptObserved: false,
          },
        });
      },
      () => {
        unlisten();
        if (deliverToUi && uiActive) callbacks.onError(message);
        uiActive = false;
      },
    );
  };

  invoke<StartCodexAppTurnResult>("codex_app_start_turn", {
    ...requestPayload,
  })
    .then((result) => {
      if (!isStartTurnResult(result)) {
        failUnknownStartOutcome(
          "Codex App Server returned an invalid start result",
          "CODEX_APP_SERVER_INVALID_START_RESULT",
        );
        return;
      }
      if (cancelledBeforeStartResolved) {
        // A proven pre-turn rejection has nothing to interrupt. Any other
        // result may represent a real turn and is interrupted fail-closed.
        if (result.status === "rejected-before-turn") {
          settled = true;
          auditTerminal = true;
          auditQueue.close(
            async () =>
              cancelAiAuditExecution(audit, {
                reason: "cleanup-before-rejected-turn-result",
                metadata: {
                  modelDispatched: false,
                  transportAbortRequested: true,
                  abortCommandAcknowledged: await requestInterrupt(),
                  transportTerminationObserved: false,
                  providerAbortReceiptObserved: false,
                  uiDeliveryEnded: true,
                  preTurnRejectionObserved: true,
                  cleanupReturnedBeforeTerminalAuditDurable: true,
                },
              }),
            unlisten,
          );
        } else {
          authoritativeInterruptSent = true;
          void requestInterrupt(true);
        }
        return;
      }
      if (settled) return;
      if (result.status === "rejected-before-turn") {
        if (
          !started &&
          transport === "auto" &&
          fallbackCli &&
          result.code !== CODEX_APP_SERVER_WORKSPACE_STALE_CODE
        ) {
          void startFallback(fallbackCli);
          return;
        }
        settled = true;
        auditTerminal = true;
        auditQueue.close(
          () =>
            failAiAuditExecution(audit, {
              error: {
                name: "CodexAppRejectedBeforeTurn",
                message: result.message,
                code: result.code,
              },
              metadata: { modelDispatched: false },
            }),
          () => {
            unlisten();
            if (uiActive) callbacks.onError(result.message);
          },
        );
        return;
      }
      started = true;
      enqueueRuntimeEvent(
        {
          phase: "start-result",
          codexThreadId: result.codexThreadId,
          codexTurnId: result.codexTurnId,
          reusedThread: result.reusedThread,
        },
        () =>
          callbacks.onTurnStarted?.({
            threadId: result.codexThreadId,
            turnId: result.codexTurnId,
          }),
      );
    })
    .catch((cause: unknown) => {
      // Rejection is deliberately unclassified: IPC itself can fail after
      // main accepted the turn. Always issue an idempotent fail-closed abort;
      // a proven pre-turn outcome is returned as a typed result above.
      const message = cause instanceof Error ? cause.message : String(cause);
      failUnknownStartOutcome(message, "CODEX_APP_SERVER_START_REJECTED");
    });

  return cleanup;
}

export async function abortCodexAppTurn(
  payload: InterruptCodexAppTurnPayload,
): Promise<void> {
  await invoke<void>("codex_app_interrupt_turn", { ...payload });
}

export async function advanceCodexHistoryRevision(
  payload: AdvanceCodexHistoryRevisionPayload,
): Promise<AdvanceCodexHistoryRevisionResult> {
  return invoke<AdvanceCodexHistoryRevisionResult>(
    "codex_app_update_history_revision",
    { ...payload },
  );
}

export async function getCodexAppServerStatus(): Promise<unknown> {
  return invoke("codex_app_get_status");
}

export async function testCodexAppServerConnection(): Promise<unknown> {
  return invoke("codex_app_test_connection");
}

export async function listCodexAppModels(): Promise<CodexModel[]> {
  return invoke<CodexModel[]>("codex_app_list_models");
}

export async function respondToCodexServerRequest(input: {
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  requestId: string | number;
  decision: "accept" | "decline";
}): Promise<void> {
  await invoke<void>("codex_app_respond_to_request", input);
}

export async function archiveCodexSessionThread(
  payload: ArchiveCodexSessionThreadPayload,
): Promise<void> {
  await invoke<void>("codex_app_archive_session_thread", {
    ...payload,
  });
}

export async function setCodexSessionThreadName(
  payload: SetCodexThreadNamePayload,
): Promise<void> {
  await invoke<void>("codex_app_set_thread_name", {
    ...payload,
  });
}
