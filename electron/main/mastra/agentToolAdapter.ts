import { jsonSchema } from "ai";
import { createTool } from "@mastra/core/tools";

import { formatToolResult } from "./agentLoopRules.js";

export interface MastraAgentToolBinding {
  readonly name: string;
  readonly description: string;
  readonly execute: (
    args: unknown,
    ctx: { toolCallId: string; signal: AbortSignal },
  ) => Promise<{
    /** JSON-serialized core content, or its summary for a null result. */
    text: string;
    tokensUsed: number;
    summary: string;
  }>;
}

const PERMISSIVE_INPUT_SCHEMA = jsonSchema<unknown>({
  type: "object",
  additionalProperties: true,
});
const TURN_STOPPED_RESULT = "Tool execution skipped because the turn stopped.";

function truncatedToolError(
  message: string,
  tokenBudget: number,
  countTokens: (text: string) => number,
): string {
  const { content } = formatToolResult(
    { content: null, summary: "", error: message },
    tokenBudget,
    countTokens,
  );
  return content.startsWith("Error: ")
    ? content.slice("Error: ".length)
    : content;
}

export function createMastraAgentTools(input: {
  readonly names: readonly string[];
  readonly bindings: readonly MastraAgentToolBinding[];
  readonly tokenBudget: number;
  readonly countTokens: (text: string) => number;
  readonly signal: AbortSignal;
  readonly isToolDeclared?: (name: string) => boolean;
  readonly isTurnStopped?: () => boolean;
  readonly onToolStart?: (event: {
    readonly toolCallId: string;
    readonly toolName: string;
  }) => void;
  readonly onToolResult?: (event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly tokens: number;
    readonly summary: string;
  }) => void;
}): Record<string, ReturnType<typeof createTool>> {
  const bindings = new Map(
    input.bindings.map((binding) => [binding.name, binding]),
  );
  return Object.fromEntries(
    input.names.map((name) => {
      const binding = bindings.get(name);
      return [
        name,
        createTool({
          id: name,
          description: binding?.description ?? "Tool unavailable this turn.",
          inputSchema: PERMISSIVE_INPUT_SCHEMA,
          execute: async (
            args: unknown,
            context: {
              agent?: { toolCallId: string };
              abortSignal?: AbortSignal;
            },
          ) => {
            if (typeof context.agent?.toolCallId !== "string") {
              throw new Error("MASTRA_AGENT_TOOL_CALL_ID_MISSING");
            }
            const toolCallId = context.agent.toolCallId;
            const isStopped = () =>
              context.abortSignal?.aborted === true ||
              input.signal.aborted ||
              input.isTurnStopped?.() === true;
            if (isStopped()) return TURN_STOPPED_RESULT;
            input.onToolStart?.({ toolCallId, toolName: name });
            if (
              binding === undefined ||
              input.isToolDeclared?.(name) === false
            ) {
              const message = `Tool not available this turn: ${name}`;
              input.onToolResult?.({
                toolCallId,
                toolName: name,
                tokens: 0,
                summary: message,
              });
              throw new Error(
                truncatedToolError(
                  message,
                  input.tokenBudget,
                  input.countTokens,
                ),
              );
            }

            let result: Awaited<ReturnType<typeof binding.execute>>;
            try {
              result = await binding.execute(args, {
                toolCallId,
                signal: context.abortSignal ?? input.signal,
              });
            } catch (error) {
              if (isStopped()) return TURN_STOPPED_RESULT;
              const message =
                error instanceof Error ? error.message : String(error);
              input.onToolResult?.({
                toolCallId,
                toolName: name,
                tokens: 0,
                summary: message,
              });
              throw new Error(
                truncatedToolError(
                  message,
                  input.tokenBudget,
                  input.countTokens,
                ),
                { cause: error },
              );
            }

            if (isStopped()) return TURN_STOPPED_RESULT;

            const formatted = formatToolResult(
              { text: result.text, summary: result.summary },
              input.tokenBudget,
              input.countTokens,
            );
            input.onToolResult?.({
              toolCallId,
              toolName: name,
              tokens: result.tokensUsed,
              summary: result.summary,
            });
            return formatted.content;
          },
        }),
      ];
    }),
  );
}
