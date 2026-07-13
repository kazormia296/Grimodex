import { invoke, listen } from "@/lib/tauri";
import * as cliApi from "./cliApi";
import type {
  CodexAppEventEnvelope,
  CodexAppItem,
  CodexModel,
  InterruptCodexAppTurnPayload,
  StartCodexAppTurnPayload,
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

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** Adapt normalized main-process events to the existing ChatStore stream callbacks. */
export async function sendCodexAppTurn(
  payload: CodexAppTurnPayload,
  callbacks: CodexAppStreamCallbacks,
): Promise<() => void> {
  let settled = false;
  let started = false;
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
        settled = true;
        callbacks.onError(event.message);
        return;
    }
  });

  const cleanup = (): void => {
    settled = true;
    unlisten();
    fallbackCleanup?.();
    fallbackCleanup = null;
  };

  const { transport, fallbackCli, ...requestPayload } = payload;
  invoke<unknown>("codex_app_start_turn", requestPayload)
    .then((result) => {
      if (settled) return;
      const threadId = stringField(result, "codexThreadId");
      const turnId = stringField(result, "codexTurnId");
      if (!threadId && !turnId) return;
      started = true;
      callbacks.onTurnStarted?.({
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
      });
    })
    .catch(async (cause: unknown) => {
      if (settled) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!started && transport === "auto" && fallbackCli) {
        unlisten();
        callbacks.onFallback?.();
        try {
          fallbackCleanup = await cliApi.sendCliChatStream(
            fallbackCli,
            callbacks,
          );
          return;
        } catch (fallbackCause) {
          settled = true;
          callbacks.onError(
            fallbackCause instanceof Error
              ? fallbackCause.message
              : String(fallbackCause),
          );
          return;
        }
      }
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
  projectId: string,
  sessionId: string,
): Promise<void> {
  await invoke<void>("codex_app_archive_session_thread", {
    projectId,
    sessionId,
  });
}

export async function setCodexSessionThreadName(
  projectId: string,
  sessionId: string,
  name: string,
): Promise<void> {
  await invoke<void>("codex_app_set_thread_name", {
    projectId,
    sessionId,
    name,
  });
}
