import type { InlineAiCommand, InlineAiContext } from "./inlineAiTypes";
import { sendInlineAiStream, abortInlineAiStream } from "./inlineAiStreaming";
import { getPromptCatalog } from "@/prompts/index";

export function buildSystemPrompt(
  command: InlineAiCommand,
  ctx: InlineAiContext,
): string {
  return getPromptCatalog("ja").inlineAi.buildSystemPrompt(command, ctx);
}

export function buildUserPrompt(
  command: InlineAiCommand,
  ctx: InlineAiContext,
): string {
  return getPromptCatalog("ja").inlineAi.buildUserPrompt(command, ctx);
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
): Promise<{ text: string; model: string; stopReason: string }> {
  const messages = [
    { role: "system", content: buildSystemPrompt(command, context) },
    { role: "user", content: buildUserPrompt(command, context) },
  ];

  let accumulated = "";
  const cleanupRef: { fn: (() => void) | null } = { fn: null };

  const result = await new Promise<{ stopReason: string }>(
    (resolve, reject) => {
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
          resolve({ stopReason: info.stopReason });
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
    },
  );

  cleanupRef.fn?.();

  return {
    text: accumulated,
    model: "claude-sonnet-4-6",
    stopReason: result.stopReason,
  };
}
