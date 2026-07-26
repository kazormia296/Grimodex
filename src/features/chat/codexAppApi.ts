import { invoke, listen } from "@/lib/tauri";
import * as cliApi from "./cliApi";
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

export interface CodexAppTurnPayload extends StartCodexAppTurnPayload {
  transport?: "app-server" | "auto";
  fallbackCli?: cliApi.CliChatPayload;
}

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

/** Adapt normalized main-process events to the existing ChatStore stream callbacks. */
export async function sendCodexAppTurn(
  payload: CodexAppTurnPayload,
  callbacks: CodexAppStreamCallbacks,
): Promise<() => void> {
  let settled = false;
  let started = false;
  // cleanup can win the race with the long-running start_turn invoke. In that
  // case the main process may only learn the authoritative Codex turn id after
  // the renderer has stopped listening, so issue a second, late interrupt once
  // start_turn resolves.
  let cancelledBeforeStartResolved = false;
  let fallbackCleanup: (() => void) | null = null;
  let latestUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  } = {};
  const unlisten = await listen<unknown>("codex-app:event", (raw) => {
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
        callbacks.onTurnStarted?.({ threadId: event.threadId });
        return;
      case "turn-started":
        started = true;
        callbacks.onTurnStarted?.({
          turnId: raw.codexTurnId ?? event.turnId,
        });
        return;
      case "text-delta":
        started = true;
        callbacks.onTextDelta(event.delta);
        return;
      case "thinking-delta":
        started = true;
        callbacks.onThinkingDelta(event.delta);
        return;
      case "item-started":
        started = true;
        callbacks.onItemStarted?.(event.item);
        return;
      case "item-completed":
        started = true;
        callbacks.onItemCompleted?.(event.item);
        return;
      case "usage":
        latestUsage = {
          inputTokens: event.inputTokens ?? latestUsage.inputTokens,
          outputTokens: event.outputTokens ?? latestUsage.outputTokens,
          cacheReadTokens:
            event.cachedInputTokens ?? latestUsage.cacheReadTokens,
        };
        return;
      case "approval-requested":
        // A server request proves that the App Server turn is already active.
        // Falling back to `codex exec` after this point could execute the same
        // request twice while the original turn is still waiting for approval.
        started = true;
        callbacks.onApprovalRequested?.(event);
        return;
      case "warning":
        callbacks.onWarning?.(event.message);
        return;
      case "turn-completed":
        settled = true;
        callbacks.onDone({
          stopReason: event.stopReason,
          inputTokens: event.inputTokens ?? latestUsage.inputTokens,
          outputTokens: event.outputTokens ?? latestUsage.outputTokens,
          cacheReadTokens:
            latestUsage.cacheReadTokens !== undefined
              ? latestUsage.cacheReadTokens
              : undefined,
        });
        return;
      case "turn-error":
        if (event.retryable === true) {
          // Codex may emit a transient error before retrying the same turn. Keep
          // the correlated listener alive and surface it as a warning; a later
          // turn-completed or non-retryable error remains authoritative.
          started = true;
          callbacks.onWarning?.(event.message);
          return;
        }
        settled = true;
        callbacks.onError(event.message);
        return;
    }
  });

  const cleanup = (): void => {
    if (!settled) cancelledBeforeStartResolved = true;
    settled = true;
    unlisten();
    fallbackCleanup?.();
    fallbackCleanup = null;
  };

  const startFallback = async (
    fallbackCli: cliApi.CliChatPayload,
  ): Promise<void> => {
    unlisten();
    callbacks.onFallback?.();
    if (settled) return;
    try {
      const resolvedFallbackCleanup = await cliApi.sendCliChatStream(
        fallbackCli,
        callbacks,
      );
      if (settled) {
        resolvedFallbackCleanup();
        return;
      }
      fallbackCleanup = resolvedFallbackCleanup;
    } catch (fallbackCause) {
      if (settled) return;
      settled = true;
      callbacks.onError(
        fallbackCause instanceof Error
          ? fallbackCause.message
          : String(fallbackCause),
      );
    }
  };

  const { transport, fallbackCli, ...requestPayload } = payload;
  invoke<StartCodexAppTurnResult>("codex_app_start_turn", requestPayload)
    .then((result) => {
      if (cancelledBeforeStartResolved) {
        // A proven pre-turn rejection has nothing to interrupt. Any other
        // result may represent a real turn and is interrupted fail-closed.
        if (!isStartTurnResult(result) || result.status === "started") {
          void abortCodexAppTurn({
            projectId: payload.projectId,
            sessionId: payload.sessionId,
            grimodexTurnId: payload.grimodexTurnId,
          }).catch(() => {});
        }
        return;
      }
      if (settled) return;
      if (!isStartTurnResult(result)) {
        void abortCodexAppTurn({
          projectId: payload.projectId,
          sessionId: payload.sessionId,
          grimodexTurnId: payload.grimodexTurnId,
        }).catch(() => {});
        settled = true;
        callbacks.onError("Codex App Server returned an invalid start result");
        return;
      }
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
        callbacks.onError(result.message);
        return;
      }
      started = true;
      callbacks.onTurnStarted?.({
        threadId: result.codexThreadId,
        turnId: result.codexTurnId,
      });
    })
    .catch((cause: unknown) => {
      // Rejection is deliberately unclassified: IPC itself can fail after
      // main accepted the turn. Always issue an idempotent fail-closed abort;
      // a proven pre-turn outcome is returned as a typed result above.
      void abortCodexAppTurn({
        projectId: payload.projectId,
        sessionId: payload.sessionId,
        grimodexTurnId: payload.grimodexTurnId,
      }).catch(() => {});
      if (cancelledBeforeStartResolved) return;
      if (settled) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      settled = true;
      callbacks.onError(message);
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
