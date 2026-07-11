import type {
  AgentMessagePayload,
  AgentToolDefinition,
  WebSearchConfig,
} from "../agent/agentTypes";
import { buildHermesToolsPreamble } from "../toolProtocolParse";
import type { ResolvedChatTurnRoute } from "./resolveTurnRoute";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function usesResponses(route: ResolvedChatTurnRoute): boolean {
  return (
    route.apiVariant === "responses" &&
    ["openai", "openai-compatible", "openrouter", "sakana"].includes(
      route.provider,
    )
  );
}

function formatHermesToolCall(
  name: string,
  input: Record<string, unknown>,
): string {
  return `<tool_call>\n${json({ name, arguments: input })}\n</tool_call>`;
}

function formatHermesToolResponse(
  name: string,
  content: string,
  isError: boolean,
): string {
  return `<tool_response>\n${json({
    name,
    content,
    ...(isError ? { is_error: true } : {}),
  })}\n</tool_response>`;
}

function renderResponsesMessages(messages: AgentMessagePayload[]): string[] {
  const rendered: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      rendered.push(json({ role: "user", content: message.content }));
      continue;
    }
    if (message.role === "tool_result") {
      rendered.push(
        json({
          type: "function_call_output",
          call_id: message.toolUseId,
          output: message.content,
        }),
      );
      continue;
    }
    for (const block of message.thinkingBlocks ?? []) {
      try {
        const metadata = JSON.parse(block.signature) as {
          id?: unknown;
          ec?: unknown;
        };
        if (
          typeof metadata.id === "string" &&
          typeof metadata.ec === "string"
        ) {
          rendered.push(
            json({
              type: "reasoning",
              id: metadata.id,
              encrypted_content: metadata.ec,
              summary: [],
            }),
          );
        }
      } catch {
        // Rust likewise ignores signatures that are not Responses metadata.
      }
    }
    if (message.content) {
      rendered.push(json({ role: "assistant", content: message.content }));
    }
    for (const toolUse of message.toolUses ?? []) {
      rendered.push(
        json({
          type: "function_call",
          call_id: toolUse.id,
          name: toolUse.name,
          arguments: json(toolUse.input),
        }),
      );
    }
  }
  return rendered;
}

function renderHermesMessages(messages: AgentMessagePayload[]): string[] {
  const rendered: string[] = [];
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      rendered.push(json({ role: "user", content: message.content }));
      continue;
    }
    if (message.role === "tool_result") {
      rendered.push(
        json({
          role: "user",
          content: formatHermesToolResponse(
            toolNameById.get(message.toolUseId) ?? "",
            message.content,
            message.isError ?? false,
          ),
        }),
      );
      continue;
    }
    let content = message.content;
    for (const toolUse of message.toolUses ?? []) {
      toolNameById.set(toolUse.id, toolUse.name);
      content += `${content ? "\n" : ""}${formatHermesToolCall(
        toolUse.name,
        toolUse.input,
      )}`;
    }
    rendered.push(json({ role: "assistant", content }));
  }
  return rendered;
}

function renderAnthropicMessages(messages: AgentMessagePayload[]): string[] {
  const rendered: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      rendered.push(json({ role: "user", content: message.content }));
      continue;
    }
    if (message.role === "tool_result") {
      rendered.push(
        json({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolUseId,
              content: message.content,
              is_error: message.isError ?? false,
            },
          ],
        }),
      );
      continue;
    }
    const toolUses = message.toolUses ?? [];
    const thinkingBlocks = message.thinkingBlocks ?? [];
    if (toolUses.length === 0 && thinkingBlocks.length === 0) {
      rendered.push(json({ role: "assistant", content: message.content }));
      continue;
    }
    rendered.push(
      json({
        role: "assistant",
        content: [
          ...thinkingBlocks.map((block) => ({
            type: "thinking",
            thinking: block.thinking,
            signature: block.signature,
          })),
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...toolUses.map((toolUse) => ({
            type: "tool_use",
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          })),
        ],
      }),
    );
  }
  return rendered;
}

function renderOpenAiMessages(messages: AgentMessagePayload[]): string[] {
  const rendered: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      rendered.push(json({ role: "user", content: message.content }));
      continue;
    }
    if (message.role === "tool_result") {
      rendered.push(
        json({
          role: "tool",
          tool_call_id: message.toolUseId,
          content: message.content,
        }),
      );
      continue;
    }
    const toolUses = message.toolUses ?? [];
    if (toolUses.length === 0) {
      rendered.push(json({ role: "assistant", content: message.content }));
      continue;
    }
    rendered.push(
      json({
        role: "assistant",
        content: message.content || null,
        tool_calls: toolUses.map((toolUse) => ({
          id: toolUse.id,
          type: "function",
          function: {
            name: toolUse.name,
            arguments: json(toolUse.input),
          },
        })),
      }),
    );
  }
  return rendered;
}

/** Materialize the same provider-specific Agent history shape built in Rust. */
export function renderAgentConversationPayloads(
  route: ResolvedChatTurnRoute,
  messages: AgentMessagePayload[],
): string[] {
  if (usesResponses(route)) return renderResponsesMessages(messages);
  if (route.toolProtocol === "hermes") return renderHermesMessages(messages);
  if (route.provider === "anthropic") {
    return renderAnthropicMessages(messages);
  }
  return renderOpenAiMessages(messages);
}

function webSearchPayload(webSearch: WebSearchConfig): unknown | null {
  if (!webSearch.enabled) return null;
  const allowed = webSearch.allowedDomains?.filter(Boolean) ?? [];
  const blocked = webSearch.blockedDomains?.filter(Boolean) ?? [];
  const controls = {
    ...(allowed.length > 0
      ? { allowed_domains: allowed }
      : blocked.length > 0
        ? { blocked_domains: blocked }
        : {}),
    ...(webSearch.maxContentTokens
      ? { max_content_tokens: webSearch.maxContentTokens }
      : {}),
  };
  return webSearch.agentic
    ? { type: "openrouter:web_search", ...controls }
    : {
        id: "web",
        max_results: webSearch.maxResults || 5,
        ...controls,
      };
}

/** Materialize provider wrappers around tool schemas, not just the renderer DTO. */
export function renderAgentToolPayloads(
  route: ResolvedChatTurnRoute,
  tools: AgentToolDefinition[],
  webSearch?: WebSearchConfig | null,
): string[] {
  const rendered: string[] = [];
  if (route.toolProtocol === "hermes") {
    // Rust injects the Hermes system preamble even when the declared tool list
    // is empty (for example, RAG-only Agent transport).
    rendered.push(buildHermesToolsPreamble(tools));
  } else if (usesResponses(route)) {
    const nativeTools = [...tools]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
    if (nativeTools.length > 0) rendered.push(json(nativeTools));
  } else if (route.provider === "anthropic") {
    const nativeTools: unknown[] = [...tools]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    if (webSearch?.enabled) {
      nativeTools.push({
        type: "web_search_20260209",
        name: "web_search",
        max_uses: webSearch.maxUses || 3,
        ...((webSearch.allowedDomains?.length ?? 0) > 0
          ? { allowed_domains: webSearch.allowedDomains }
          : (webSearch.blockedDomains?.length ?? 0) > 0
            ? { blocked_domains: webSearch.blockedDomains }
            : {}),
      });
    }
    if (nativeTools.length > 0) rendered.push(json(nativeTools));
  } else {
    const nativeTools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    if (nativeTools.length > 0) rendered.push(json(nativeTools));
  }

  if (route.provider === "openrouter" && webSearch?.enabled) {
    const payload = webSearchPayload(webSearch);
    if (payload) rendered.push(json(payload));
  }
  return rendered;
}
