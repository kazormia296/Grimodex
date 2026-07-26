import { invoke, listen } from "@/lib/tauri";

interface StreamChunkPayload {
  delta: string;
  block_type: "text" | "thinking";
}

interface StreamDonePayload {
  stop_reason: string;
  input_tokens: number | null;
  output_tokens: number | null;
  /** N4: OpenRouter streaming の usage.cost (USD)。他プロバイダは null/欠落。 */
  cost?: number | null;
}

interface StreamErrorPayload {
  message: string;
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
  callbacks: InlineAiStreamCallbacks,
  options?: {
    model?: string | null;
    apiVariant?: string | null;
    // 機能別モデルのプロバイダ横断 override。
    provider?: string | null;
    endpointId?: string | null;
  },
): Promise<() => void> {
  const unlisteners = await Promise.all([
    listen<StreamChunkPayload>("inline-ai:stream-chunk", (payload) => {
      // thinking ブロックはインライン AI では無視（設計書上、扱わない）
      if (payload.block_type === "text") {
        callbacks.onTextDelta(payload.delta);
      }
    }),
    listen<StreamDonePayload>("inline-ai:stream-done", (payload) => {
      callbacks.onDone({
        stopReason: payload.stop_reason,
        inputTokens: payload.input_tokens,
        outputTokens: payload.output_tokens,
        cost: payload.cost,
      });
    }),
    listen<StreamErrorPayload>("inline-ai:stream-error", (payload) => {
      callbacks.onError(payload.message);
    }),
  ]);

  const cleanup = () => {
    unlisteners.forEach((u) => u());
  };

  invoke<void>("send_inline_ai_stream", {
    messages,
    thinking: null,
    effort: null,
    reasoningEnabled: null,
    reasoningEffort: null,
    model: options?.model ?? null,
    apiVariant: options?.apiVariant ?? null,
    provider: options?.provider ?? null,
    endpointId: options?.endpointId ?? null,
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    callbacks.onError(msg);
  });

  return cleanup;
}

/** 進行中のインライン AI ストリームを中止する。 */
export async function abortInlineAiStream(): Promise<void> {
  await invoke<void>("abort_inline_ai_stream");
}
