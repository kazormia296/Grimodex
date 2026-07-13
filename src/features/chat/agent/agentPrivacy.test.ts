import { describe, expect, it } from "vitest";

import { resolveAgentPrivacyPlan } from "./agentPrivacy";
import type { WebSearchConfig } from "./agentTypes";

const WEB_SEARCH: WebSearchConfig = {
  enabled: true,
  agentic: true,
  maxResults: 5,
  maxUses: 3,
};

describe("resolveAgentPrivacyPlan", () => {
  it("keeps private Agent turns completely separate from Web search", () => {
    expect(
      resolveAgentPrivacyPlan({
        agentMode: true,
        ragActive: true,
        webSearchConfig: WEB_SEARCH,
      }),
    ).toEqual({
      contextMode: "private",
      includePrivateContext: true,
      includeConversationHistory: true,
      webSearchConfig: null,
    });
  });

  it("allows public RAG only without private project context or history", () => {
    expect(
      resolveAgentPrivacyPlan({
        agentMode: false,
        ragActive: true,
        webSearchConfig: WEB_SEARCH,
      }),
    ).toEqual({
      contextMode: "public-web",
      includePrivateContext: false,
      includeConversationHistory: false,
      webSearchConfig: WEB_SEARCH,
    });
  });

  it("does not enable Web search when the route is not an active RAG turn", () => {
    expect(
      resolveAgentPrivacyPlan({
        agentMode: false,
        ragActive: false,
        webSearchConfig: WEB_SEARCH,
      }),
    ).toEqual({
      contextMode: "private",
      includePrivateContext: true,
      includeConversationHistory: true,
      webSearchConfig: null,
    });
  });
});
