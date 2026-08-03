/**
 * CLI プロバイダ (Claude Code / Codex / OpenCode) を Chat バックエンドとして
 * 利用するための Tauri command ラッパ。
 *
 * - HTTP/inlineストリームとの混信を避ける専用 `cli:stream-chunk` /
 *   `cli:stream-done` / `cli:stream-error` イベントを使う。
 * - subprocess 起動なので、API キーや baseURL は使わない。代わりに binary path /
 *   model / cli kind を payload で渡す。
 */

import { invoke, listen } from "@/lib/tauri";
import type { CliKind } from "./types";
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
  beforeIpcDispatchDetails,
  nativeAiAuditContext,
  type AiAuditTransportContext,
} from "@/features/ai-audit/transportContext";
import type {
  AiAuditExecutionHandle,
  AiAuditRequestSnapshot,
} from "@/features/ai-audit/types";

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
}

interface StreamErrorPayload {
  streamId: string;
  message: string;
}

interface StreamAbortReceipt {
  abortCommandAcknowledged: boolean;
  transportTerminationObserved: boolean;
}

export interface CliStreamCallbacks {
  onTextDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onDone: (info: {
    stopReason: string;
    inputTokens?: number;
    outputTokens?: number;
  }) => void;
  onError: (message: string) => void;
}

export interface CliChatPayload {
  cli: CliKind;
  binaryPath?: string;
  model?: string;
  /** 単一プロンプト本体。CLI には引数として渡される (`-p <prompt>` 等)。 */
  prompt: string;
}

export function cliAuditRequest(
  payload: CliChatPayload,
): AiAuditRequestSnapshot {
  return {
    provider: "cli",
    ...(payload.model ? { model: payload.model } : {}),
    messages: [{ role: "user", content: payload.prompt }],
    options: { cli: payload.cli },
    auditMetadata: {
      runtimeObservation: {
        captureState: "partial",
        binaryPathExcluded: true,
        externalRuntimeInternalPromptObserved: false,
        providerPrivateThinkingObserved: false,
      },
    },
  };
}

/**
 * CLI subprocess を起動して stream-chunk / stream-done イベントを発火させる。
 * 戻り値はリスナー解除用の cleanup 関数。
 */
export async function sendCliChatStream(
  payload: CliChatPayload,
  auditContext: AiAuditTransportContext,
  callbacks: CliStreamCallbacks,
  preparedAudit?: AiAuditExecutionHandle,
): Promise<() => void> {
  const audit =
    preparedAudit ??
    (await beginAiAuditExecution({
      ...auditContext,
      request: cliAuditRequest(payload),
      captureState: "partial",
      limitations: [
        "external-runtime-internal-prompt-unobservable",
        "provider-private-thinking-unobservable",
        "audit-storage-failure-may-prevent-recovery-terminal",
        "renderer-cleanup-returns-before-cancel-audit-is-durable",
        "hard-process-kill-may-leave-dispatched-without-terminal",
      ],
    }));
  const streamId = audit.executionId;
  let errorDelivered = false;
  const reportError = (message: string): void => {
    if (errorDelivered) return;
    errorDelivered = true;
    callbacks.onError(message);
  };
  // CLI 専用のイベント名空間 (cli:stream-*) を使う。
  // HTTP 系チャット (chat:stream-*) と inline AI が同じバスを使っているため、
  // CLI も同じイベント名にすると複数ストリーム同時走行時に混信する。
  let text = "";
  let thinking = "";
  let transportTerminal = false;
  let uiActive = true;
  let cleanupRequested = false;
  let abortCommand: Promise<StreamAbortReceipt> | null = null;
  let streamSequence = 0;
  const unlisteners: Array<() => void> = [];
  const releaseListeners = (): void => {
    unlisteners.splice(0).forEach((unlisten) => unlisten());
  };
  const requestAbort = (): Promise<StreamAbortReceipt> => {
    abortCommand ??= abortCliChatStream(streamId);
    return abortCommand;
  };
  const reportAuditFailure = (error: unknown): void => {
    const deliverToUi = uiActive;
    transportTerminal = true;
    uiActive = false;
    releaseListeners();
    void requestAbort();
    void attemptAiAuditPersistenceFailureTerminal(audit, {
      persistenceError: error,
      partialResponse: { text, thinking },
      metadata: {
        transport: "cli-stream",
        transportAbortRequested: true,
        terminalRecoveryBypassedFailedQueue: true,
      },
    });
    if (deliverToUi) {
      reportError(
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
      await listen<StreamChunkPayload>("cli:stream-chunk", (p) => {
        if (transportTerminal || p.streamId !== streamId) return;
        const deliverToUi = uiActive;
        streamSequence += 1;
        const sequence = streamSequence;
        if (p.block_type === "thinking") {
          thinking += p.delta;
        } else {
          text += p.delta;
        }
        auditQueue.enqueue(
          {
            receivedAt: Date.now(),
            response: {
              streamSequence: sequence,
              blockType: p.block_type,
              delta: p.delta,
            },
          },
          () => {
            if (!deliverToUi || !uiActive) return;
            if (p.block_type === "thinking") {
              callbacks.onThinkingDelta(p.delta);
            } else {
              callbacks.onTextDelta(p.delta);
            }
          },
        );
      }),
    );
    unlisteners.push(
      await listen<StreamDonePayload>("cli:stream-done", (p) => {
        if (transportTerminal || p.streamId !== streamId) return;
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
            if (p.stop_reason === "stopped") {
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
              response: { text, thinking, stopReason: p.stop_reason },
              usage: {
                inputTokens: p.input_tokens ?? null,
                outputTokens: p.output_tokens ?? null,
                stopReason: p.stop_reason,
              },
              metadata: {
                externalRuntimeInternalPromptObserved: false,
                ...(cleanupRequested
                  ? {
                      transportAbortRequested: true,
                      abortCommandAcknowledged:
                        abortReceipt.abortCommandAcknowledged,
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
            releaseListeners();
            if (deliverToUi && uiActive) {
              callbacks.onDone({
                stopReason: p.stop_reason,
                inputTokens: p.input_tokens,
                outputTokens: p.output_tokens,
              });
            }
          },
        );
      }),
    );
    unlisteners.push(
      await listen<StreamErrorPayload>("cli:stream-error", (p) => {
        if (transportTerminal || p.streamId !== streamId) return;
        transportTerminal = true;
        const deliverToUi = uiActive;
        auditQueue.close(
          async () => {
            const abortReceipt = cleanupRequested ? await requestAbort() : null;
            await failAiAuditExecution(audit, {
              error: { name: "CliRuntimeError", message: p.message },
              partialResponse: { text, thinking },
              metadata: {
                externalRuntimeInternalPromptObserved: false,
                ...(abortReceipt
                  ? {
                      transportAbortRequested: true,
                      abortCommandAcknowledged:
                        abortReceipt.abortCommandAcknowledged,
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
            releaseListeners();
            if (deliverToUi && uiActive) reportError(p.message);
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
      beforeIpcDispatchDetails("send_cli_chat_stream"),
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

  invoke<void>("send_cli_chat_stream", {
    payload,
    streamId,
    auditContext: nativeAiAuditContext(audit),
  }).catch((e: unknown) => {
    if (transportTerminal) return;
    transportTerminal = true;
    const msg = e instanceof Error ? e.message : String(e);
    auditQueue.close(
      async () => {
        const abortReceipt = cleanupRequested ? await requestAbort() : null;
        await failAiAuditExecution(audit, {
          error: auditErrorSnapshot(e),
          partialResponse: { text, thinking },
          metadata: {
            externalRuntimeInternalPromptObserved: false,
            ...(abortReceipt
              ? {
                  transportAbortRequested: true,
                  abortCommandAcknowledged:
                    abortReceipt.abortCommandAcknowledged,
                  transportTerminationObserved:
                    abortReceipt.transportTerminationObserved,
                  providerAbortReceiptObserved: false,
                  uiDeliveryEnded: true,
                  auditObservationContinuedUntilTransportTerminal: true,
                  cleanupReturnedBeforeTerminalAuditDurable: true,
                }
              : {}),
          },
        });
      },
      () => {
        releaseListeners();
        if (uiActive) reportError(msg);
      },
    );
  });

  return cleanup;
}

/** 進行中の CLI ストリームを abort する */
export async function abortCliChatStream(
  streamId: string,
): Promise<StreamAbortReceipt> {
  try {
    const receipt = await invoke<Partial<StreamAbortReceipt>>(
      "abort_cli_chat_stream",
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

/**
 * CLI バイナリを PATH 上から探す。
 * 見つかればフルパス、なければ null。Settings の「自動検出」ボタンで使う。
 */
export async function detectCliBinary(cli: CliKind): Promise<string | null> {
  const result = await invoke<string | null>("detect_cli_binary", { cli });
  return result;
}

/** `<binary> --version` を叩いて起動可否を確認する */
export async function testCliConnection(binaryPath: string): Promise<string> {
  return invoke<string>("test_cli_connection", { binaryPath });
}

/** CLI が利用可能なモデル一覧を取得する */
export async function listCliModels(
  cli: CliKind,
  binaryPath?: string,
): Promise<Array<{ id: string; name: string }>> {
  return invoke<Array<{ id: string; name: string }>>("list_cli_models", {
    cli,
    binaryPath: binaryPath || null,
  });
}
