import type { NapiBackendLike } from "../shared/ipcContract.js";
import { productJourneyChronicleResponse } from "./productJourneyChronicleAi.js";

export const PRODUCT_JOURNEY_AI_ENV = "GRIMODEX_PRODUCT_JOURNEY_FAKE_AI";
export const PRODUCT_JOURNEY_AI_VERSION = "deterministic-v1";
export const PRODUCT_JOURNEY_AUTHORITY_EARLY = "AUTHORITY-OLD-EARLY";
export const PRODUCT_JOURNEY_AUTHORITY_LATE = "AUTHORITY-OLD-LATE";
export const PRODUCT_JOURNEY_AUTHORING_OUTPUT = "AUTHORING-AI-OUTPUT";
export const PRODUCT_JOURNEY_CODEX_MARKER = "CODEX-CONTEXT-JOURNEY";
export const PRODUCT_JOURNEY_AGENT_MARKER = "AGENT-AUTHORITY-JOURNEY";
export const PRODUCT_JOURNEY_AGENT_OUTPUT = "AGENT-OLD-SCOPE-OUTPUT";
export const PRODUCT_JOURNEY_AGENT_PROJECT_SWITCH_OUTPUT =
  "AGENT-PROJECT-SWITCH-OUTPUT";
export const PRODUCT_JOURNEY_AGENT_WORKSPACE_SWITCH_OUTPUT =
  "AGENT-WORKSPACE-SWITCH-OUTPUT";

const STREAM_BOUNDARY_DELAY_MS = 4_000;

type BackendEventSink = (...args: unknown[]) => unknown;

interface ProductJourneyStream {
  streamId: string;
  aborted: boolean;
  quiesced: Promise<void>;
  resolveQuiesced: () => void;
}

function streamIdFromArgs(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("product journey AI stream args must be an object");
  }
  const request = args as {
    streamId?: unknown;
    auditContext?: { executionId?: unknown };
  };
  if (
    typeof request.streamId !== "string" ||
    !request.streamId.trim() ||
    request.streamId !== request.streamId.trim() ||
    request.auditContext?.executionId !== request.streamId
  ) {
    throw new Error(
      "product journey AI streamId must equal auditContext.executionId",
    );
  }
  return request.streamId;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function messageText(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "";
  }
  const messages = (args as { messages?: unknown }).messages;
  return Array.isArray(messages) ? JSON.stringify(messages) : "";
}

function emit(
  sink: BackendEventSink | null,
  channel: string,
  payload: unknown,
): void {
  if (!sink) {
    throw new Error(
      "product journey AI emitted before the backend event sink was registered",
    );
  }
  sink(channel, JSON.stringify(payload));
}

export function shouldUseProductJourneyAi({
  isPackaged,
  env = process.env,
}: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return (
    !isPackaged && env[PRODUCT_JOURNEY_AI_ENV] === PRODUCT_JOURNEY_AI_VERSION
  );
}

/**
 * Keep the real native backend for persistence and every non-AI command while
 * replacing only the HTTP provider edge with deterministic replies/events.
 * The wrapper is unreachable in packaged builds and requires an exact,
 * product-runner-owned environment value.
 */
export function wrapBackendForProductJourneyAi(
  backend: NapiBackendLike | null,
  enabled: boolean,
): NapiBackendLike | null {
  if (!backend || !enabled) return backend;

  let eventSink: BackendEventSink | null = null;
  let activeStream: ProductJourneyStream | null = null;
  const pendingAborts = new Set<string>();

  const overrides: Partial<NapiBackendLike> = {
    onEvent(callback) {
      eventSink = callback;
      backend.onEvent(callback);
    },

    async sendChatMessage(args) {
      return JSON.stringify({
        blocks: [
          {
            type: "text",
            content: productJourneyChronicleResponse(args) ?? "Product Journey",
          },
        ],
        stopReason: "end_turn",
        inputTokens: 1,
        outputTokens: 2,
      });
    },

    async sendAgentMessage(args) {
      const input = messageText(args);
      const authorityJourney = input.includes(PRODUCT_JOURNEY_AGENT_MARKER);
      const projectSwitch = input.includes("AGENT-PROJECT-SWITCH-PROMPT");
      const workspaceSwitch = input.includes("AGENT-WORKSPACE-SWITCH-PROMPT");
      if (authorityJourney || projectSwitch || workspaceSwitch)
        await wait(STREAM_BOUNDARY_DELAY_MS);
      return JSON.stringify({
        blocks: [
          {
            type: "text",
            content: authorityJourney
              ? PRODUCT_JOURNEY_AGENT_OUTPUT
              : projectSwitch
                ? PRODUCT_JOURNEY_AGENT_PROJECT_SWITCH_OUTPUT
                : workspaceSwitch
                  ? PRODUCT_JOURNEY_AGENT_WORKSPACE_SWITCH_OUTPUT
                  : "Product Journey Agent",
          },
        ],
        stopReason: "end_turn",
        inputTokens: 1,
        outputTokens: authorityJourney ? 4 : 2,
      });
    },

    async sendChatMessageStream(args) {
      if (activeStream) {
        throw new Error("product journey AI supports one active stream");
      }
      const streamId = streamIdFromArgs(args);
      let resolveQuiesced = () => {};
      const quiesced = new Promise<void>((resolve) => {
        resolveQuiesced = resolve;
      });
      const stream: ProductJourneyStream = {
        streamId,
        aborted: pendingAborts.delete(streamId),
        quiesced,
        resolveQuiesced,
      };
      activeStream = stream;
      const input = messageText(args);
      const authoring = input.includes(PRODUCT_JOURNEY_CODEX_MARKER);
      const early = authoring
        ? PRODUCT_JOURNEY_AUTHORING_OUTPUT
        : PRODUCT_JOURNEY_AUTHORITY_EARLY;

      try {
        if (stream.aborted) {
          emit(eventSink, "chat:stream-done", {
            streamId,
            stop_reason: "stopped",
            input_tokens: null,
            output_tokens: null,
          });
          return;
        }
        emit(eventSink, "chat:stream-chunk", {
          streamId,
          delta: early,
          block_type: "text",
        });
        await wait(STREAM_BOUNDARY_DELAY_MS);

        // Deliberately publish one already-in-flight chunk after abort. The
        // renderer keeps it in the correlated audit while suppressing UI.
        if (!authoring) {
          emit(eventSink, "chat:stream-chunk", {
            streamId,
            delta: PRODUCT_JOURNEY_AUTHORITY_LATE,
            block_type: "text",
          });
        }
        emit(eventSink, "chat:stream-done", {
          streamId,
          stop_reason: stream.aborted ? "stopped" : "end_turn",
          input_tokens: 1,
          output_tokens: authoring ? 3 : 4,
        });
      } finally {
        if (activeStream === stream) activeStream = null;
        stream.resolveQuiesced();
      }
    },

    async abortChatStream(streamId) {
      if (activeStream?.streamId === streamId) {
        activeStream.aborted = true;
        await activeStream.quiesced;
        return true;
      }
      pendingAborts.add(streamId);
      if (pendingAborts.size > 256) {
        pendingAborts.delete(pendingAborts.values().next().value ?? "");
      }
      return false;
    },

    async listAiModels() {
      return JSON.stringify([
        {
          id: "product-journey-model",
          name: "Product Journey Model",
          contextLength: 32_768,
          effectiveContextLength: 32_768,
          effectiveContextSource: "runner",
          maxCompletionTokens: 4_096,
          supportedParameters: ["tools"],
        },
      ]);
    },
  };

  return new Proxy(backend, {
    get(target, property) {
      const override = Reflect.get(overrides, property);
      if (override !== undefined) return override;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
