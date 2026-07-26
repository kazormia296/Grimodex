import type { WebSearchConfig } from "./agentTypes";

export type AgentContextMode = "private" | "public-web";

export interface AgentPrivacyPlan {
  /** private project context and public Web search never share a plan. */
  contextMode: AgentContextMode;
  includePrivateContext: boolean;
  includeConversationHistory: boolean;
  webSearchConfig: WebSearchConfig | null;
}

export interface ResolveAgentPrivacyPlanInput {
  agentMode: boolean;
  ragActive: boolean;
  webSearchConfig: WebSearchConfig | null;
}

/**
 * Resolve the data boundary before constructing an Agent prompt.
 *
 * A public RAG turn receives only the current user request and Web results;
 * it must not inherit project context or conversation history. A private
 * Agent turn may read project data, but Web search is forcibly disabled.
 */
export function resolveAgentPrivacyPlan(
  input: ResolveAgentPrivacyPlanInput,
): AgentPrivacyPlan {
  if (!input.agentMode && input.ragActive && input.webSearchConfig) {
    return {
      contextMode: "public-web",
      includePrivateContext: false,
      includeConversationHistory: false,
      webSearchConfig: input.webSearchConfig,
    };
  }

  return {
    contextMode: "private",
    includePrivateContext: true,
    includeConversationHistory: true,
    webSearchConfig: null,
  };
}
