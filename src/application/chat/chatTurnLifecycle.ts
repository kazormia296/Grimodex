import {
  cancelCurrentChatInput,
  captureCurrentChatInput,
  isElectron,
  retireCurrentChatInput,
  type CaptureCurrentChatInputSubmission,
} from "@/lib/tauri";
import { resolveActiveOpenaiCompatibleEndpoint } from "@/features/chat/types";
import type { AiSettings } from "@/features/chat/types";
import { tryAcquireChatTurnAdmissionLease } from "@/lib/chatNavigationGuard";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import type { ChatStoreSet } from "./chatStoreActionPorts";
import type { ChatState } from "./chatStoreTypes";
import type { ChatTurnRuntime } from "./chatTurnRuntime";
import type { ResolvedChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";
import type { TurnControl } from "@/features/chat/turn/turnCoordinator";
import type { ChatScope } from "@/features/chat/chatScope";

type SendOptions = NonNullable<Parameters<ChatState["sendMessage"]>[2]>;

interface CaptureRouteEligibilityInput {
  turnRoute: ResolvedChatTurnRoute | null;
  aiSettingsEarly: AiSettings | null;
  chatScope: ChatScope;
  effectiveSceneId: string | null;
  activeSceneId: string;
  scopeAnchorId: string | null;
  threadFocusOverride: { threadId: string; title: string } | null;
  useAgentPath: boolean;
  capturedRagEnabled: boolean;
  ragActive: boolean;
  publicWebSearchPath: boolean;
  commandInstruction?: string;
  options?: SendOptions;
}

interface CaptureCallbacks {
  cancelBeforeTransport: () => boolean;
  failBeforeTransport: (error: unknown) => void;
  preserveFailedCaptureCancellation: (error: unknown) => void;
  onAccepted?: () => void;
}

interface ChatTurnLifecycleDependencies {
  set: ChatStoreSet;
  get: () => ChatState;
  turnRuntime: ChatTurnRuntime;
  isCapturedWorkspaceCurrent: typeof import("./chatSessionAuthority").isCapturedWorkspaceCurrent;
  getCurrentProjectId: typeof import("@/application/project/currentProjectAuthority").getCurrentProjectId;
  codexAppApi: typeof import("@/features/chat/lazyRuntimeApi").codexAppApi;
  debugLog: typeof import("@/lib/debugLog").debugLog;
  errorDetail: typeof import("@/lib/debugLog").errorDetail;
}

export interface ChatTurnCaptureLifecycle {
  readonly submission: CaptureCurrentChatInputSubmission | null;
  readonly committed: boolean;
  isCaptureOnly: () => boolean;
  notifyAccepted: (onAccepted?: () => void) => void;
  hasCancellationRetry: () => boolean;
  markCancellationRetryReady: () => void;
  preserveFailedCancellation: (
    error: unknown,
    removeOwnedTurnMessages: () => void,
  ) => void;
  clearCancellationRetry: () => void;
  cancel: () => Promise<void>;
  capture: (
    submission: CaptureCurrentChatInputSubmission,
    projectId: string,
    callbacks: CaptureCallbacks,
  ) => Promise<boolean>;
  retirePriorCapture: (sessionId: string | null) => Promise<void>;
  keepCurrent: () => void;
  resolveFinally: (workspaceIsCurrent: boolean) => boolean;
}

export function createChatTurnLifecycle(
  dependencies: ChatTurnLifecycleDependencies,
) {
  const {
    set,
    get,
    turnRuntime,
    isCapturedWorkspaceCurrent,
    getCurrentProjectId,
    codexAppApi,
    debugLog,
    errorDetail,
  } = dependencies;
  const pendingCaptureCancellationRetries = new WeakMap<
    TurnControl,
    () => Promise<void>
  >();
  const pendingCaptureCancellationRetriesReady = new WeakSet<TurnControl>();
  const pendingCaptureOnlyControls = new WeakSet<TurnControl>();
  const pendingCaptureCancellationActions = new WeakMap<
    TurnControl,
    () => Promise<void>
  >();
  let stopGenerationVersion = 0;

  const isCaptureLoopbackEndpoint = (baseUrl: string): boolean => {
    const match =
      /^http:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\]):([1-9]\d*)\/v1\/?$/i.exec(
        baseUrl,
      );
    if (!match) return false;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const host = match[1]!.toLowerCase();
    if (host.startsWith("127.")) {
      const octets = host.split(".");
      return octets.slice(1).every((part) => {
        const octet = Number(part);
        return octet >= 0 && octet <= 255 && String(octet) === part;
      });
    }
    return true;
  };

  const captureRouteIsEligible = (
    input: CaptureRouteEligibilityInput,
  ): boolean => {
    const {
      turnRoute,
      aiSettingsEarly,
      chatScope,
      effectiveSceneId,
      activeSceneId,
      scopeAnchorId,
      threadFocusOverride,
      useAgentPath,
      capturedRagEnabled,
      ragActive,
      publicWebSearchPath,
      commandInstruction,
      options,
    } = input;
    const captureEndpoint =
      turnRoute && aiSettingsEarly
        ? resolveActiveOpenaiCompatibleEndpoint(
            aiSettingsEarly,
            turnRoute.resolvedEndpointId,
          )
        : undefined;
    return Boolean(
      isElectron() &&
      turnRoute &&
      turnRoute.surface === "chat" &&
      turnRoute.source === "active" &&
      turnRoute.provider === "openai-compatible" &&
      turnRoute.providerOverride === null &&
      turnRoute.transport === "http" &&
      turnRoute.endpointId === null &&
      // The shared route resolver labels OpenAI-compatible's no-variant
      // default as "legacy"; reject explicit variants and Responses routes.
      (turnRoute.apiVariant === null || turnRoute.apiVariant === "legacy") &&
      turnRoute.toolProtocol === "native" &&
      turnRoute.model === aiSettingsEarly?.model &&
      aiSettingsEarly?.provider === "openai-compatible" &&
      aiSettingsEarly.model.trim().length > 0 &&
      aiSettingsEarly.modelApiVariant == null &&
      captureEndpoint !== undefined &&
      captureEndpoint.apiVariant == null &&
      captureEndpoint.id === turnRoute.resolvedEndpointId &&
      captureEndpoint.baseUrl === captureEndpoint.baseUrl.trim() &&
      isCaptureLoopbackEndpoint(captureEndpoint.baseUrl) &&
      chatScope === "scene" &&
      effectiveSceneId !== null &&
      effectiveSceneId === activeSceneId &&
      scopeAnchorId === null &&
      threadFocusOverride === null &&
      !useAgentPath &&
      !capturedRagEnabled &&
      !ragActive &&
      !publicWebSearchPath &&
      commandInstruction === undefined &&
      options?.overrideAgentMode === undefined &&
      !options?._replaceAssistantMessageId &&
      !options?.mentionedSceneIds?.length &&
      !options?.mentionedCodexIds?.length,
    );
  };

  const beforeSend = (
    sendStopGeneration: number,
  ): boolean | Promise<boolean> => {
    const turnCoordinator = turnRuntime.coordinator;
    const pendingControl = turnCoordinator.current();
    if (!pendingControl?.preTransportAdmissionPending) return true;
    if (!isCapturedWorkspaceCurrent(pendingControl.request.workspace)) {
      if (pendingCaptureOnlyControls.has(pendingControl)) {
        turnCoordinator.abort(pendingControl);
        set((state) => ({
          messages: state.messages.filter(
            (message) =>
              message.id !== pendingControl.userMessageId &&
              message.id !== pendingControl.assistantMessageId,
          ),
          streamingDraft:
            state.streamingDraft?.messageId ===
            pendingControl.assistantMessageId
              ? null
              : state.streamingDraft,
          isStreaming: false,
        }));
        turnRuntime.clearActiveRouteIf(turnRuntime.activeRoute());
      }
      pendingCaptureOnlyControls.delete(pendingControl);
      pendingCaptureCancellationActions.delete(pendingControl);
      pendingCaptureCancellationRetries.delete(pendingControl);
      pendingCaptureCancellationRetriesReady.delete(pendingControl);
      turnCoordinator.release(pendingControl, "failed");
      return true;
    }

    const captureOnly = pendingCaptureOnlyControls.has(pendingControl);
    const retryCancellation =
      pendingCaptureCancellationRetries.get(pendingControl);
    const cancelCapture =
      retryCancellation ??
      (captureOnly
        ? pendingCaptureCancellationActions.get(pendingControl)
        : undefined);
    if (
      !cancelCapture ||
      (!captureOnly &&
        !pendingCaptureCancellationRetriesReady.has(pendingControl))
    ) {
      return false;
    }
    if (captureOnly) {
      turnCoordinator.abort(pendingControl);
      set((state) => ({
        messages: state.messages.filter(
          (message) => message.id !== pendingControl.assistantMessageId,
        ),
        streamingDraft:
          state.streamingDraft?.messageId === pendingControl.assistantMessageId
            ? null
            : state.streamingDraft,
        isStreaming: false,
      }));
    }
    return (async () => {
      try {
        await cancelCapture();
      } catch (error) {
        if (pendingCaptureCancellationRetries.has(pendingControl)) {
          pendingCaptureCancellationRetriesReady.add(pendingControl);
        }
        debugLog.warn(
          "ChatStore",
          "retry current chat capture cancellation",
          errorDetail(error),
        );
        return false;
      }
      if (sendStopGeneration !== stopGenerationVersion) return false;
      if (pendingControl.preTransportAdmissionPending) return false;
      pendingCaptureOnlyControls.delete(pendingControl);
      pendingCaptureCancellationActions.delete(pendingControl);
      turnCoordinator.release(pendingControl, "failed");
      return true;
    })();
  };

  const createTurn = (
    sendControl: TurnControl,
    turnRoute: ResolvedChatTurnRoute | null,
  ): ChatTurnCaptureLifecycle => {
    let acceptedNotified = false;
    let captureAttempted = false;
    let captureRetirementAttempted = false;
    let captureCommitted = false;
    let keepCurrentCapture = false;
    let captureSubmission: CaptureCurrentChatInputSubmission | null = null;
    let captureCancellation: Promise<void> | null = null;

    const notifyAccepted = (onAccepted?: () => void): void => {
      if (acceptedNotified) return;
      acceptedNotified = true;
      try {
        onAccepted?.();
      } catch (error) {
        debugLog.warn(
          "ChatStore",
          "send acceptance callback",
          errorDetail(error),
        );
      }
    };

    const preserveFailedCancellation = (
      error: unknown,
      removeOwnedTurnMessages: () => void,
    ): void => {
      if (turnRuntime.coordinator.isCurrent(sendControl)) {
        turnRuntime.coordinator.abort(sendControl);
        removeOwnedTurnMessages();
        set({
          isStreaming: false,
          error: error instanceof Error ? error.message : String(error),
        });
        turnRuntime.clearActiveRouteIf(turnRoute);
      }
      if (pendingCaptureCancellationRetries.has(sendControl)) {
        pendingCaptureCancellationRetriesReady.add(sendControl);
      }
    };

    const cancelCurrentCapture = (): Promise<void> => {
      if (captureCancellation) return captureCancellation;
      if (
        !captureAttempted ||
        !captureSubmission ||
        (keepCurrentCapture && !sendControl.aborted)
      ) {
        return Promise.resolve();
      }
      const submission = captureSubmission;
      const currentCancellation = (async () => {
        try {
          const receipt = await cancelCurrentChatInput({
            submissionId: submission.submissionId,
            messageId: submission.messageId,
            chatSessionId: submission.chatSessionId,
            sceneId: submission.sceneId,
          });
          if (
            receipt.status !== "cancelled" &&
            receipt.status !== "not-current" &&
            receipt.status !== "not-found"
          ) {
            throw new Error("IPC_CAPTURE_CANCEL_TERMINAL_RECEIPT_INVALID");
          }
          captureAttempted = false;
          sendControl.preTransportAdmissionPending = false;
          if (pendingCaptureOnlyControls.has(sendControl)) {
            turnRuntime.clearActiveRouteIf(turnRoute);
            pendingCaptureOnlyControls.delete(sendControl);
            pendingCaptureCancellationActions.delete(sendControl);
          }
          pendingCaptureCancellationRetries.delete(sendControl);
          pendingCaptureCancellationRetriesReady.delete(sendControl);
        } catch (error) {
          if (!captureAttempted || captureSubmission !== submission) return;
          pendingCaptureCancellationRetries.set(
            sendControl,
            cancelCurrentCapture,
          );
          throw error;
        }
      })();
      const trackedCancellation = currentCancellation.finally(() => {
        if (captureCancellation === trackedCancellation) {
          captureCancellation = null;
        }
      });
      captureCancellation = trackedCancellation;
      return trackedCancellation;
    };

    const capture = async (
      submission: CaptureCurrentChatInputSubmission,
      projectId: string,
      callbacks: CaptureCallbacks,
    ): Promise<boolean> => {
      captureSubmission = submission;
      captureAttempted = true;
      sendControl.preTransportAdmissionPending = true;
      let receipt: Awaited<ReturnType<typeof captureCurrentChatInput>>;
      try {
        receipt = await captureCurrentChatInput(submission);
        if (
          receipt.status === "accepted" &&
          (receipt.projectId !== projectId ||
            receipt.chatSessionId !== submission.chatSessionId ||
            receipt.sceneId !== submission.sceneId ||
            receipt.messageId !== submission.messageId)
        ) {
          throw new Error("IPC_CAPTURE_RESULT_BINDING_MISMATCH");
        }
        captureCommitted = receipt.status === "accepted";
      } catch (error) {
        try {
          await cancelCurrentCapture();
        } catch (cleanupError) {
          debugLog.error(
            "ChatStore",
            "cancel failed chat capture",
            errorDetail(cleanupError),
          );
          callbacks.preserveFailedCaptureCancellation(cleanupError);
          return false;
        }
        callbacks.failBeforeTransport(error);
        return false;
      }
      if (receipt.status === "legacy-only") {
        captureAttempted = false;
        captureSubmission = null;
        sendControl.preTransportAdmissionPending = false;
        pendingCaptureCancellationRetries.delete(sendControl);
        pendingCaptureCancellationRetriesReady.delete(sendControl);
      } else {
        if (callbacks.cancelBeforeTransport()) {
          try {
            await cancelCurrentCapture();
          } catch (cleanupError) {
            callbacks.preserveFailedCaptureCancellation(cleanupError);
            return false;
          }
          turnRuntime.coordinator.release(sendControl);
          return false;
        }
        pendingCaptureOnlyControls.add(sendControl);
        pendingCaptureCancellationActions.set(
          sendControl,
          cancelCurrentCapture,
        );
        notifyAccepted(callbacks.onAccepted);
        return false;
      }
      if (callbacks.cancelBeforeTransport()) {
        try {
          await cancelCurrentCapture();
        } catch (cleanupError) {
          callbacks.preserveFailedCaptureCancellation(cleanupError);
          return false;
        }
        turnRuntime.coordinator.release(sendControl);
        return false;
      }
      return true;
    };

    const retirePriorCapture = async (
      sessionId: string | null,
    ): Promise<void> => {
      if (!isElectron() || !sessionId || captureRetirementAttempted) return;
      captureRetirementAttempted = true;
      sendControl.preTransportAdmissionPending = true;
      try {
        const receipt = await retireCurrentChatInput(sessionId);
        if (
          receipt.status !== "legacy-only" &&
          receipt.chatSessionId !== sessionId
        ) {
          throw new Error("IPC_CHAT_CAPTURE_RETIRE_RESULT_BINDING_MISMATCH");
        }
      } finally {
        sendControl.preTransportAdmissionPending = false;
        if (sendControl.aborted) turnRuntime.coordinator.release(sendControl);
      }
    };

    return {
      get submission() {
        return captureSubmission;
      },
      get committed() {
        return captureCommitted;
      },
      isCaptureOnly: () => pendingCaptureOnlyControls.has(sendControl),
      notifyAccepted,
      hasCancellationRetry: () =>
        pendingCaptureCancellationRetries.has(sendControl),
      markCancellationRetryReady: () =>
        pendingCaptureCancellationRetriesReady.add(sendControl),
      preserveFailedCancellation,
      clearCancellationRetry: () =>
        pendingCaptureCancellationRetries.delete(sendControl),
      cancel: cancelCurrentCapture,
      capture,
      retirePriorCapture,
      keepCurrent: () => {
        keepCurrentCapture = true;
      },
      resolveFinally: (workspaceIsCurrent) => {
        const unresolvedCurrentCapture =
          sendControl.preTransportAdmissionPending && workspaceIsCurrent;
        if (
          unresolvedCurrentCapture &&
          pendingCaptureCancellationRetries.has(sendControl)
        ) {
          pendingCaptureCancellationRetriesReady.add(sendControl);
        }
        return unresolvedCurrentCapture;
      },
    };
  };

  const stopGeneration = (): void => {
    stopGenerationVersion += 1;
    // A send may still be waiting for Ollama metadata before placeholders are
    // published. Invalidate that claim so Stop (or a new authority) can recover
    // without waiting for the endpoint timeout.
    turnRuntime.clearSendPreflight();
    // agent ループの中断を要求してから、回答待ちの ask_user を sentinel 解決する。
    // フラグを先に立てるので、resolve で再開したループは shouldAbort を見て
    // tool_result を送らずに即 return する（stop が agent path を止められない
    // 問題への対処）。フラグ→resolve の順序が肝。
    const turnCoordinator = turnRuntime.coordinator;
    const stoppedControl = turnCoordinator.current();
    const stoppedTurnId = stoppedControl?.id ?? null;
    const stoppedSessionId = stoppedControl?.sessionId ?? get().activeSessionId;
    const stoppedProjectId =
      stoppedControl?.request.projectId ??
      get().activeProjectId ??
      getCurrentProjectId();
    if (stoppedControl) {
      turnCoordinator.abort(stoppedControl);
      if (!stoppedControl.transportStarted) {
        const preserveCapturedHuman =
          pendingCaptureOnlyControls.has(stoppedControl);
        set((state) => ({
          messages: state.messages.filter(
            (message) =>
              message.id !== stoppedControl.assistantMessageId &&
              (preserveCapturedHuman ||
                message.id !== stoppedControl.userMessageId),
          ),
          streamingDraft:
            state.streamingDraft?.messageId ===
            stoppedControl.assistantMessageId
              ? null
              : state.streamingDraft,
        }));
      }
    }
    // Flush while this turn still owns the identity; flushDelta deliberately
    // rejects stale owners, so clearing the id first would drop the final frame.
    turnRuntime.flushPendingDelta();
    const agentTransportWillFinalize = Boolean(
      stoppedControl?.transportStarted && stoppedControl.surface === "agent",
    );
    if (stoppedControl?.transportStarted && stoppedControl.surface === "chat") {
      turnRuntime.finalizeStoppedStream();
    }
    // Keep the turn claim while a committed capture is awaiting its exact
    // terminal cancellation; a replacement may enter only after that receipt.
    if (
      !agentTransportWillFinalize &&
      stoppedControl &&
      !stoppedControl.preTransportAdmissionPending
    ) {
      turnCoordinator.release(stoppedControl);
    }
    const cancelAcceptedCapture = stoppedControl
      ? pendingCaptureCancellationActions.get(stoppedControl)
      : undefined;
    if (stoppedControl && cancelAcceptedCapture) {
      void cancelAcceptedCapture().then(
        () => turnCoordinator.release(stoppedControl),
        (error: unknown) => {
          if (pendingCaptureCancellationRetries.has(stoppedControl)) {
            pendingCaptureCancellationRetriesReady.add(stoppedControl);
          }
          debugLog.warn(
            "ChatStore",
            "cancel current chat capture on Stop",
            errorDetail(error),
          );
        },
      );
    }
    // Stop は送信開始時に凍結した transport を使う。Codex App Server は
    // subprocess 全体を終了せず、対象 Thread/Turn だけを interrupt する。
    const stoppedTransport =
      stoppedControl?.transport ??
      turnRuntime.activeRoute()?.transport ??
      "http";
    if (
      stoppedTransport === "codex-app-server" &&
      stoppedTurnId &&
      stoppedSessionId
    ) {
      void codexAppApi
        .abortCodexAppTurn({
          projectId: stoppedProjectId,
          sessionId: stoppedSessionId,
          grimodexTurnId: stoppedTurnId,
        })
        .catch(() => {});
    }
    if (!agentTransportWillFinalize) {
      turnRuntime.runStreamCleanup();
    }
    get()._cancelPendingUserQuestion();
    set({
      isStreaming: agentTransportWillFinalize,
      agentProgress: null,
    });
  };

  const createStreamingDraftFinalizer =
    (assistantMessageId: string): ((metadata?: string) => void) =>
    (metadata) => {
      set((state) => {
        const draft =
          state.streamingDraft?.messageId === assistantMessageId
            ? state.streamingDraft
            : null;
        let changed = draft !== null;
        const messages = state.messages.map((message) => {
          if (message.id !== assistantMessageId) return message;
          const content = draft?.content ?? message.content;
          if (
            content === message.content &&
            (metadata === undefined || metadata === message.metadata)
          ) {
            return message;
          }
          changed = true;
          return {
            ...message,
            content,
            ...(metadata !== undefined ? { metadata } : {}),
          };
        });
        return {
          messages: changed ? messages : state.messages,
          streamingDraft: null,
        };
      });
    };

  return {
    stopGeneration,
    stopGenerationVersion: () => stopGenerationVersion,
    isStopGenerationCurrent: (version: number) =>
      version === stopGenerationVersion,
    beforeSend,
    createTurn,
    createStreamingDraftFinalizer,
    captureRouteIsEligible,
  };
}

export function withChatTurnAdmission(
  sendMessage: ChatState["sendMessage"],
  turnRuntime: ChatTurnRuntime,
): ChatState["sendMessage"] {
  return async (content, commandInstruction, options) => {
    const navigationAdmission = tryAcquireChatTurnAdmissionLease();
    if (!navigationAdmission) return;
    let admissionReleased = false;
    const releaseNavigationAdmission = (): void => {
      if (admissionReleased) return;
      admissionReleased = true;
      navigationAdmission.release();
    };
    try {
      if (!canScheduleQuiescenceMutation()) return;
      // A completed turn owns the next persistence position until its retry
      // succeeds. Keep this gate outside trackTurn: a failed admission retry
      // must remain sticky in the registry, not become a second settled turn
      // failure.
      if (turnRuntime.hasPendingCompletedTurnPersistence()) {
        await turnRuntime.retryPendingCompletedTurns();
      }
      if (!canScheduleQuiescenceMutation()) return;
      const admittedOptions = {
        ...options,
        _onAccepted: () => {
          // `notifyAccepted` runs after turn placeholders/finalizers exist
          // and immediately before transport starts. From this point a Scene
          // transition can stop the turn and persist to captured authority.
          releaseNavigationAdmission();
          options?._onAccepted?.();
        },
      };
      return await turnRuntime.trackTurn(
        sendMessage(content, commandInstruction, admittedOptions),
      );
    } finally {
      releaseNavigationAdmission();
    }
  };
}
