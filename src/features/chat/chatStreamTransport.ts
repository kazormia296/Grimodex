import {
  attemptAiAuditPersistenceFailureTerminal,
  beginAiAuditExecution,
  cancelAiAuditExecution,
  completeAiAuditExecution,
  failAiAuditExecution,
  markAiAuditDispatched,
  recordAiAuditPartials,
  type AiAuditPartialInput,
} from "@/features/ai-audit/api";
import { createOrderedStreamAuditBatchQueue } from "@/features/ai-audit/orderedStreamAudit";
import {
  auditErrorSnapshot,
  auditRequestFromChatArgs,
  beforeIpcDispatchDetails,
  nativeAiAuditContext,
  type AiAuditTransportContext,
} from "@/features/ai-audit/transportContext";
import { invoke, listen } from "@/lib/tauri";
import type { ThinkingParams } from "./agent/modelLimits";
import {
  chatAuditRouteCoverage,
  resolveChatAuditRoute,
} from "./singleShotTransport";

interface StreamChunkPayload {
  streamId: string;
  delta: string;
  block_type: "text" | "thinking";
}

interface StreamDonePayload {
  streamId: string;
  stop_reason: string;
  input_tokens?: number;
  output_tokens?: number;
  /** N4: OpenRouter streaming の usage.cost (USD)。他プロバイダは null/欠落。 */
  cost?: number;
  /** N4: prompt cache 読込トークン (cache hit)。欠落=キャッシュ未使用/未到達。 */
  cache_read_tokens?: number;
  /** N4: prompt cache 書込トークン (cache write、コスト側)。 */
  cache_write_tokens?: number;
}

interface StreamErrorPayload {
  streamId: string;
  message: string;
}

interface StreamAbortReceipt {
  abortCommandAcknowledged: boolean;
  transportTerminationObserved: boolean;
}

export interface StreamCallbacks {
  onTextDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onDone: (info: {
    stopReason: string;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }) => void;
  onError: (message: string) => void;
}

/**
 * Send a chat message with streaming response.
 * Returns a cleanup function to remove event listeners.
 */
export async function sendChatMessageStream(
  messages: { role: string; content: string }[],
  thinkingParams: ThinkingParams | undefined,
  callbacks: StreamCallbacks,
  auditContext: AiAuditTransportContext,
  systemCacheSegments?: string[],
  apiVariant?: string | null,
  systemVolatileTail?: string,
  model?: string | null,
  /**
   * Chat の別プロバイダ一時送信: プロバイダ override（null/未指定 = 設定の既定プロバイダ）。
   * 値は `AiProvider` 文字列。送信モデル(model)と同じプロバイダの名前空間に属していること。
   */
  provider?: string | null,
  /**
   * OpenAI 互換: このストリームだけ別エンドポイントへ向ける override。
   * null/未指定なら設定の active エンドポイント。provider!=互換 では無視される。
   */
  endpointId?: string | null,
  /** Finalized output limit shared with the context reservation. */
  requestMaxOutputTokens?: number | null,
  /** Immutable route snapshot; takes precedence over the legacy override. */
  resolvedProvider?: string | null,
  resolvedEndpointId?: string | null,
  /** Ollama endpoint authority snapshot; backend compares but never trusts it as a URL. */
  expectedOllamaEndpoint?: string | null,
): Promise<() => void> {
  const args: Record<string, unknown> = {
    messages,
    thinking: thinkingParams?.thinking ?? null,
    effort: thinkingParams?.effort ?? null,
    reasoningEnabled: thinkingParams?.reasoningEnabled ?? null,
    reasoningEffort: thinkingParams?.reasoningEffort ?? null,
    systemCacheSegments: systemCacheSegments ?? null,
    apiVariant: apiVariant ?? null,
    systemVolatileTail: systemVolatileTail ?? null,
    model: model ?? null,
    provider: resolvedProvider ?? provider ?? null,
    endpointId: resolvedEndpointId ?? endpointId ?? null,
    expectedOllamaEndpoint: expectedOllamaEndpoint ?? null,
    ...(requestMaxOutputTokens != null ? { requestMaxOutputTokens } : {}),
  };
  const route = resolveChatAuditRoute(args);
  const routeCoverage = chatAuditRouteCoverage(route);
  const audit = await beginAiAuditExecution({
    ...auditContext,
    request: auditRequestFromChatArgs(args, route),
    ...routeCoverage,
    limitations: [
      ...(routeCoverage.limitations ?? []),
      "audit-storage-failure-may-prevent-recovery-terminal",
    ],
  });
  const streamId = audit.executionId;
  args.streamId = streamId;
  args.auditContext = nativeAiAuditContext(audit);
  let text = "";
  let thinking = "";
  let transportTerminal = false;
  let uiActive = true;
  let cleanupRequested = false;
  let abortCommand: Promise<StreamAbortReceipt> | null = null;
  let streamSequence = 0;
  let auditErrorDelivered = false;
  const unlisteners: Array<() => void> = [];
  const releaseListeners = (): void => {
    unlisteners.splice(0).forEach((unlisten) => unlisten());
  };
  const requestAbort = (): Promise<StreamAbortReceipt> => {
    abortCommand ??= abortChatStream(streamId);
    return abortCommand;
  };
  const reportAuditFailure = (error: unknown): void => {
    if (auditErrorDelivered) return;
    const deliverToUi = uiActive;
    auditErrorDelivered = true;
    transportTerminal = true;
    uiActive = false;
    releaseListeners();
    void requestAbort();
    void attemptAiAuditPersistenceFailureTerminal(audit, {
      persistenceError: error,
      partialResponse: { text, thinking },
      metadata: {
        transport: "chat-stream",
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
  const auditQueue = createOrderedStreamAuditBatchQueue<AiAuditPartialInput>({
    persistBatch: (items) => recordAiAuditPartials(audit, items),
    onPersistenceFailure: reportAuditFailure,
  });
  try {
    unlisteners.push(
      await listen<StreamChunkPayload>("chat:stream-chunk", (payload) => {
        if (transportTerminal || payload.streamId !== streamId) return;
        const deliverToUi = uiActive;
        streamSequence += 1;
        if (payload.block_type === "thinking") {
          thinking += payload.delta;
        } else {
          text += payload.delta;
        }
        const partial: AiAuditPartialInput = {
          receivedAt: Date.now(),
          response: {
            streamSequence,
            blockType: payload.block_type,
            delta: payload.delta,
          },
        };
        auditQueue.enqueue(partial, () => {
          if (!deliverToUi || !uiActive) return;
          if (payload.block_type === "thinking") {
            callbacks.onThinkingDelta(payload.delta);
          } else {
            callbacks.onTextDelta(payload.delta);
          }
        });
      }),
    );
    unlisteners.push(
      await listen<StreamDonePayload>("chat:stream-done", (payload) => {
        if (transportTerminal || payload.streamId !== streamId) return;
        transportTerminal = true;
        const deliverToUi = uiActive;
        auditQueue.close(
          async () => {
            const abortReceipt = cleanupRequested
              ? await requestAbort()
              : {
                  abortCommandAcknowledged: false,
                  transportTerminationObserved: true,
                };
            if (payload.stop_reason === "stopped") {
              await cancelAiAuditExecution(audit, {
                reason: "stopped",
                partialResponse: { text, thinking },
                metadata: {
                  transportAbortRequested: cleanupRequested,
                  abortCommandAcknowledged:
                    abortReceipt.abortCommandAcknowledged,
                  transportTerminationObserved: true,
                  providerAbortReceiptObserved: false,
                  ...(cleanupRequested
                    ? {
                        uiDeliveryEnded: true,
                        auditObservationContinuedUntilTransportTerminal: true,
                        cleanupReturnedBeforeTerminalAuditDurable: true,
                        hardProcessKillMayLeaveDispatchedWithoutTerminal: true,
                      }
                    : {}),
                },
              });
              return;
            }
            await completeAiAuditExecution(audit, {
              response: {
                text,
                thinking,
                stopReason: payload.stop_reason,
              },
              usage: {
                inputTokens: payload.input_tokens ?? null,
                outputTokens: payload.output_tokens ?? null,
                cost: payload.cost ?? null,
                cacheReadTokens: payload.cache_read_tokens ?? null,
                cacheWriteTokens: payload.cache_write_tokens ?? null,
                stopReason: payload.stop_reason,
              },
              ...(cleanupRequested
                ? {
                    metadata: {
                      transportAbortRequested: true,
                      abortCommandAcknowledged:
                        abortReceipt.abortCommandAcknowledged,
                      transportTerminationObserved: true,
                      providerAbortReceiptObserved: false,
                      uiDeliveryEnded: true,
                      auditObservationContinuedUntilTransportTerminal: true,
                      cleanupReturnedBeforeTerminalAuditDurable: true,
                      abortRacedWithProviderCompletion: true,
                    },
                  }
                : {}),
            });
          },
          () => {
            releaseListeners();
            if (deliverToUi && uiActive) {
              callbacks.onDone({
                stopReason: payload.stop_reason,
                inputTokens: payload.input_tokens,
                outputTokens: payload.output_tokens,
                cost: payload.cost,
                cacheReadTokens: payload.cache_read_tokens,
                cacheWriteTokens: payload.cache_write_tokens,
              });
            }
          },
        );
      }),
    );
    unlisteners.push(
      await listen<StreamErrorPayload>("chat:stream-error", (payload) => {
        if (transportTerminal || payload.streamId !== streamId) return;
        transportTerminal = true;
        const deliverToUi = uiActive;
        auditQueue.close(
          async () => {
            const abortReceipt = cleanupRequested ? await requestAbort() : null;
            await failAiAuditExecution(audit, {
              error: { name: "ProviderError", message: payload.message },
              partialResponse: { text, thinking },
              ...(abortReceipt
                ? {
                    metadata: {
                      transportAbortRequested: true,
                      abortCommandAcknowledged:
                        abortReceipt.abortCommandAcknowledged,
                      transportTerminationObserved: true,
                      providerAbortReceiptObserved: false,
                      uiDeliveryEnded: true,
                      auditObservationContinuedUntilTransportTerminal: true,
                      cleanupReturnedBeforeTerminalAuditDurable: true,
                      abortRacedWithProviderFailure: true,
                    },
                  }
                : {}),
            });
          },
          () => {
            releaseListeners();
            if (deliverToUi && uiActive) callbacks.onError(payload.message);
          },
        );
      }),
    );
  } catch (error) {
    unlisteners.forEach((unlisten) => unlisten());
    await failAiAuditExecution(audit, {
      error: auditErrorSnapshot(error),
      metadata: { phase: "listener-setup", providerDispatched: false },
    });
    throw error;
  }

  try {
    await markAiAuditDispatched(
      audit,
      beforeIpcDispatchDetails("send_chat_message_stream"),
    );
  } catch (error) {
    unlisteners.forEach((unlisten) => unlisten());
    throw error;
  }

  const cleanup = () => {
    if (!uiActive && cleanupRequested) return;
    uiActive = false;
    if (transportTerminal) return;
    cleanupRequested = true;
    void requestAbort();
  };

  // Fire-and-forget the stream command (events arrive via listeners above)
  invoke<void>("send_chat_message_stream", args).catch((error: unknown) => {
    // Error is also emitted as chat:stream-error from Rust, but handle here too
    if (transportTerminal) return;
    transportTerminal = true;
    const message = error instanceof Error ? error.message : String(error);
    auditQueue.close(
      async () => {
        const abortReceipt = cleanupRequested ? await requestAbort() : null;
        await failAiAuditExecution(audit, {
          error: auditErrorSnapshot(error),
          partialResponse: { text, thinking },
          ...(abortReceipt
            ? {
                metadata: {
                  transportAbortRequested: true,
                  abortCommandAcknowledged:
                    abortReceipt.abortCommandAcknowledged,
                  transportTerminationObserved:
                    abortReceipt.transportTerminationObserved,
                  providerAbortReceiptObserved: false,
                  uiDeliveryEnded: true,
                  auditObservationContinuedUntilTransportTerminal: true,
                  cleanupReturnedBeforeTerminalAuditDurable: true,
                },
              }
            : {}),
        });
      },
      () => {
        releaseListeners();
        if (uiActive) callbacks.onError(message);
      },
    );
  });

  return cleanup;
}

/** Abort an in-progress streaming response. */
export async function abortChatStream(
  streamId: string,
): Promise<StreamAbortReceipt> {
  try {
    const receipt = await invoke<Partial<StreamAbortReceipt>>(
      "abort_chat_stream",
      { streamId },
    );
    return {
      abortCommandAcknowledged: receipt?.abortCommandAcknowledged === true,
      transportTerminationObserved:
        receipt?.transportTerminationObserved === true,
    };
  } catch {
    return {
      abortCommandAcknowledged: false,
      transportTerminationObserved: false,
    };
  }
}
