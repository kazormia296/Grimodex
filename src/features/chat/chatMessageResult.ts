import type { ChatResponsePayload } from "./singleShotTransport";

export interface ChatMessageResult {
  text: string;
  thinkingBlocks: Array<{
    thinking: string;
    summary?: string;
    signature?: string;
  }>;
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt cache reads/writes when the provider reported them. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Project a single-shot response onto the plain-text chat result. */
export function toChatMessageResult(
  response: ChatResponsePayload,
): ChatMessageResult {
  const text = response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");
  const thinkingBlocks = response.blocks
    .filter((b) => b.type === "thinking")
    .map((b) => {
      const tb = b as {
        type: "thinking";
        content: string;
        summary?: string;
        signature?: string;
      };
      return {
        thinking: tb.content,
        summary: tb.summary,
        signature: tb.signature,
      };
    });
  return {
    text,
    thinkingBlocks,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    ...(response.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: response.cacheReadTokens }),
    ...(response.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: response.cacheWriteTokens }),
  };
}
