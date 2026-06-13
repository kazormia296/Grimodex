import type { InlineAiCommand, InlineAiContext } from "./inlineAiTypes";
import { sendInlineAiStream, abortInlineAiStream } from "./inlineAiStreaming";
import { getPromptCatalog } from "@/prompts/index";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { serializePromptMessages } from "@/features/attribution/generationLogApi";

export function buildSystemPrompt(
  command: InlineAiCommand,
  ctx: InlineAiContext,
  lang = "ja",
): string {
  return getPromptCatalog(lang).inlineAi.buildSystemPrompt(command, ctx);
}

export function buildUserPrompt(
  command: InlineAiCommand,
  ctx: InlineAiContext,
  lang = "ja",
): string {
  return getPromptCatalog(lang).inlineAi.buildUserPrompt(command, ctx);
}

/**
 * インライン AI をストリーミング実行する。
 * - chunk 受信のたびに `onChunk` が呼ばれる（真のストリーミング）
 * - `signal.aborted` になるとバックエンドに abort コマンドを送る
 * - Promise は `stop_reason === "stopped"` でも resolve し、呼び出し側で中止と
 *   通常終了を区別できるよう `stopReason` を返す
 */
export async function generateInlineAi(
  command: InlineAiCommand,
  context: InlineAiContext,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  lang = "ja",
): Promise<{
  text: string;
  model: string;
  stopReason: string;
  promptText: string;
}> {
  const messages = [
    { role: "system", content: buildSystemPrompt(command, context, lang) },
    { role: "user", content: buildUserPrompt(command, context, lang) },
  ];

  let accumulated = "";
  const cleanupRef: { fn: (() => void) | null } = { fn: null };

  const result = await new Promise<{
    stopReason: string;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
  }>((resolve, reject) => {
    const onAbort = () => {
      abortInlineAiStream().catch(() => {});
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    sendInlineAiStream(messages, {
      onTextDelta: (delta) => {
        accumulated += delta;
        onChunk(delta);
      },
      onDone: (info) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({
          stopReason: info.stopReason,
          inputTokens: info.inputTokens,
          outputTokens: info.outputTokens,
          cost: info.cost ?? null,
        });
      },
      onError: (message) => {
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(message));
      },
    })
      .then((c) => {
        cleanupRef.fn = c;
      })
      .catch((e: unknown) => {
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });

  cleanupRef.fn?.();

  // N4: インライン AI 生成の usage を台帳に記録する (model は設定値を採用)。
  void recordAiUsage({
    surface: "inline_ai",
    tokensIn: result.inputTokens,
    tokensOut: result.outputTokens,
    costUsd: result.cost,
  });

  return {
    text: accumulated,
    model: "claude-sonnet-4-6",
    stopReason: result.stopReason,
    promptText: serializePromptMessages(messages),
  };
}
