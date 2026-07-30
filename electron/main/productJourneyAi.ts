import type { NapiBackendLike } from "../shared/ipcContract.js";

export const PRODUCT_JOURNEY_AI_ENV = "GRIMODEX_PRODUCT_JOURNEY_FAKE_AI";
export const PRODUCT_JOURNEY_AI_VERSION = "deterministic-v1";
export const PRODUCT_JOURNEY_AUTHORITY_EARLY = "AUTHORITY-OLD-EARLY";
export const PRODUCT_JOURNEY_AUTHORITY_LATE = "AUTHORITY-OLD-LATE";
export const PRODUCT_JOURNEY_AUTHORING_OUTPUT = "AUTHORING-AI-OUTPUT";
export const PRODUCT_JOURNEY_CODEX_MARKER = "CODEX-CONTEXT-JOURNEY";

const STREAM_BOUNDARY_DELAY_MS = 4_000;

type BackendEventSink = (...args: unknown[]) => unknown;

interface ProductJourneyStream {
  aborted: boolean;
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
 * replacing only the HTTP provider edge with deterministic stream events.
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

  const overrides: Partial<NapiBackendLike> = {
    onEvent(callback) {
      eventSink = callback;
      backend.onEvent(callback);
    },

    async sendChatMessage() {
      return JSON.stringify({
        blocks: [
          {
            type: "text",
            content: "Product Journey",
          },
        ],
        stopReason: "end_turn",
        inputTokens: 1,
        outputTokens: 2,
      });
    },

    async sendChatMessageStream(args) {
      if (activeStream) {
        throw new Error("product journey AI supports one active stream");
      }
      const stream: ProductJourneyStream = { aborted: false };
      activeStream = stream;
      const input = messageText(args);
      const authoring = input.includes(PRODUCT_JOURNEY_CODEX_MARKER);
      const early = authoring
        ? PRODUCT_JOURNEY_AUTHORING_OUTPUT
        : PRODUCT_JOURNEY_AUTHORITY_EARLY;

      try {
        emit(eventSink, "chat:stream-chunk", {
          delta: early,
          block_type: "text",
        });
        await wait(STREAM_BOUNDARY_DELAY_MS);

        // Deliberately publish one already-in-flight chunk after abort. This
        // models the boundary race the renderer authority guard must reject.
        if (!authoring) {
          emit(eventSink, "chat:stream-chunk", {
            delta: PRODUCT_JOURNEY_AUTHORITY_LATE,
            block_type: "text",
          });
        }
        emit(eventSink, "chat:stream-done", {
          stop_reason: stream.aborted ? "stopped" : "end_turn",
          input_tokens: 1,
          output_tokens: authoring ? 3 : 4,
        });
      } finally {
        if (activeStream === stream) activeStream = null;
      }
    },

    abortChatStream() {
      if (activeStream) activeStream.aborted = true;
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
