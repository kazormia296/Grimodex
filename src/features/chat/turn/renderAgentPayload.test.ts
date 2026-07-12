import { describe, expect, it } from "vitest";

import agentPayloadFixtureJson from "./fixtures/openaiNativeAgentPayload.json";
import type {
  AgentMessagePayload,
  AgentToolDefinition,
  WebSearchConfig,
} from "../agent/agentTypes";
import {
  renderAgentConversationPayloads,
  renderAgentToolPayloads,
} from "./renderAgentPayload";
import type { ResolvedChatTurnRoute } from "./resolveTurnRoute";

function route(
  overrides: Partial<ResolvedChatTurnRoute> = {},
): ResolvedChatTurnRoute {
  return {
    provider: "openai-compatible",
    apiVariant: null,
    toolProtocol: "native",
    ...overrides,
  } as unknown as ResolvedChatTurnRoute;
}

interface AgentPayloadFixture {
  input: {
    messages: AgentMessagePayload[];
    tools: AgentToolDefinition[];
  };
  expected: {
    messages: unknown[];
    tools: unknown[];
  };
}

const agentPayloadFixture =
  agentPayloadFixtureJson as unknown as AgentPayloadFixture;

function parsePayloads(payloads: string[]): unknown[] {
  return payloads.map((payload) => JSON.parse(payload) as unknown);
}

describe("Agent provider materialization", () => {
  it("OpenAI-compatible native history and tool schemas match the captured Rust wire", () => {
    const renderedConversation = renderAgentConversationPayloads(
      route(),
      agentPayloadFixture.input.messages,
    );
    expect(renderedConversation).toEqual(
      agentPayloadFixture.expected.messages.map((message) =>
        JSON.stringify(message),
      ),
    );

    const renderedTools = renderAgentToolPayloads(
      route(),
      agentPayloadFixture.input.tools,
    );
    expect(renderedTools).toEqual([
      JSON.stringify(agentPayloadFixture.expected.tools),
    ]);
  });

  it("OpenRouter keeps auto engine without controls and forces exa with domains", () => {
    const openRouter = route({ provider: "openrouter" });
    const plain: WebSearchConfig = {
      enabled: true,
      agentic: true,
      maxContentTokens: 0,
    };
    expect(
      parsePayloads(renderAgentToolPayloads(openRouter, [], plain)),
    ).toEqual([{ type: "openrouter:web_search" }]);

    const controlled: WebSearchConfig = {
      enabled: true,
      agentic: true,
      allowedDomains: ["docs.example.com"],
      blockedDomains: ["ignored.example.com"],
    };
    expect(
      parsePayloads(renderAgentToolPayloads(openRouter, [], controlled)),
    ).toEqual([
      {
        type: "openrouter:web_search",
        engine: "exa",
        allowed_domains: ["docs.example.com"],
      },
    ]);
  });

  it("OpenRouter plugin includes the same exa content cap as Rust", () => {
    const webSearch: WebSearchConfig = {
      enabled: true,
      agentic: false,
      maxResults: 8,
      maxContentTokens: 4_000,
    };
    expect(
      parsePayloads(
        renderAgentToolPayloads(
          route({ provider: "openrouter" }),
          [],
          webSearch,
        ),
      ),
    ).toEqual([
      {
        id: "web",
        max_results: 8,
        engine: "exa",
        max_content_tokens: 4_000,
      },
    ]);
  });
});
