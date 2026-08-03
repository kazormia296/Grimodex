import { invoke, listen } from "@/lib/tauri";
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
import {
  chatAuditRouteCoverage,
  resolveChatAuditRoute,
} from "@/features/chat/singleShotTransport";

interface StreamChunkPayload {
  streamId: string;
  delta: string;
  block_type: "text" | "thinking";
}

interface StreamDonePayload {
  streamId: string;
  stop_reason: string;
  input_tokens: number | null;
  output_tokens: number | null;
  /** N4: OpenRouter streaming の usage.cost (USD)。他プロバイダは null/欠落。 */
  cost?: number | null;
}

interface StreamErrorPayload {
  streamId: string;
  message: string;
}

interface StreamAbortReceipt {
  abortCommandAcknowledged: boolean;
  transportTerminationObserved: boolean;
}

export interface InlineAiStreamCallbacks {
  onTextDelta: (delta: string) => void;
  onDone: (info: {
    stopReason: string;
    inputTokens: number | null;
    outputTokens: number | null;
    cost?: number | null;
  }) => void;
  onError: (message: string) => void;
}

/**
 * Inline-AI 専用のストリーミング呼び出し。Chat 側と完全に分離された
 * `inline-ai:stream-*` イベントを listen するので、両者が同時に走っても
 * 混線しない。戻り値はイベントリスナ解除用クリーンアップ関数。
 */
export async function sendInlineAiStream(
  messages: { role: string; content: string }[],
  auditContext: AiAuditTransportContext,
  callbacks: InlineAiStreamCallbacks,
  options?: {
    model?: string | null;
    apiVariant?: string | null;
    // 機能別モデルのプロバイダ横断 override。
    provider?: string | null;
    endpointId?: string | null;
  },
): Promise<() => void> {
  const args: Record<string, unknown> = {
    messages,
    thinking: null,
    effort: null,
    reasoningEnabled: null,
    reasoningEffort: null,
    model: options?.model ?? null,
    apiVariant: options?.apiVariant ?? null,
    provider: options?.provider ?? null,
    endpointId: options?.endpointId ?? null,
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
    abortCommand ??= abortInlineAiStream(streamId);
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
        transport: "inline-ai-stream",
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
      await listen<StreamChunkPayload>("inline-ai:stream-chunk", (payload) => {
        if (transportTerminal || payload.streamId !== streamId) return;
        const deliverToUi = uiActive;
        streamSequence += 1;
        const sequence = streamSequence;
        if (payload.block_type === "thinking") {
          thinking += payload.delta;
        } else {
          text += payload.delta;
        }
        auditQueue.enqueue(
          {
            receivedAt: Date.now(),
            response: {
              streamSequence: sequence,
              blockType: payload.block_type,
              delta: payload.delta,
            },
          },
          () => {
            if (deliverToUi && uiActive && payload.block_type === "text") {
              callbacks.onTextDelta(payload.delta);
            }
          },
        );
      }),
    );
    unlisteners.push(
      await listen<StreamDonePayload>("inline-ai:stream-done", (payload) => {
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
                inputTokens: payload.input_tokens,
                outputTokens: payload.output_tokens,
                cost: payload.cost ?? null,
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
              });
            }
          },
        );
      }),
    );
    unlisteners.push(
      await listen<StreamErrorPayload>("inline-ai:stream-error", (payload) => {
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
      beforeIpcDispatchDetails("send_inline_ai_stream"),
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

  invoke<void>("send_inline_ai_stream", args).catch((e: unknown) => {
    if (transportTerminal) return;
    transportTerminal = true;
    const msg = e instanceof Error ? e.message : String(e);
    auditQueue.close(
      async () => {
        const abortReceipt = cleanupRequested ? await requestAbort() : null;
        await failAiAuditExecution(audit, {
          error: auditErrorSnapshot(e),
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
        if (uiActive) callbacks.onError(msg);
      },
    );
  });

  return cleanup;
}

/** 進行中のインライン AI ストリームを中止する。 */
export async function abortInlineAiStream(
  streamId: string,
): Promise<StreamAbortReceipt> {
  try {
    const receipt = await invoke<Partial<StreamAbortReceipt>>(
      "abort_inline_ai_stream",
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
