import {
  renderAgentConversationPayloads,
  renderAgentToolPayloads,
} from "../../../../electron/shared/agentPayloadRenderer.js";
import type {
  AgentMessagePayload,
  AgentToolDefinition,
  WebSearchConfig,
} from "../agent/agentTypes";
import type { ResolvedChatTurnRoute } from "./resolveTurnRoute";

type Assert<T extends true> = T;
export type RendererAgentPayloadCompatibility = Assert<
  [
    AgentMessagePayload extends Parameters<
      typeof renderAgentConversationPayloads
    >[1][number]
      ? true
      : false,
    AgentToolDefinition extends Parameters<
      typeof renderAgentToolPayloads
    >[1][number]
      ? true
      : false,
    WebSearchConfig extends NonNullable<
      Parameters<typeof renderAgentToolPayloads>[2]
    >
      ? true
      : false,
    ResolvedChatTurnRoute extends Parameters<
      typeof renderAgentConversationPayloads
    >[0]
      ? true
      : false,
  ] extends [true, true, true, true]
    ? true
    : false
>;

export * from "../../../../electron/shared/agentPayloadRenderer.js";
