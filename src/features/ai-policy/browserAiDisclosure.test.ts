import { describe, expect, it } from "vitest";
import {
  BROWSER_AI_DATA_POLICY_VERSION,
  createByokAiDataDisclosure,
} from "./browserAiDisclosure";

describe("browser BYOK AI disclosure", () => {
  it.each([
    ["openai", "not-used"],
    ["anthropic", "not-used"],
    ["openrouter", "depends"],
    ["ollama", "depends"],
  ] as const)(
    "explains sent data, local storage, retention, and training for %s",
    (provider, trainingStatus) => {
      const disclosure = createByokAiDataDisclosure(provider);

      expect(disclosure).toMatchObject({
        schemaVersion: "grimodex/ai-data-disclosure/1",
        policyVersion: BROWSER_AI_DATA_POLICY_VERSION,
        route: "byok",
        provider,
        consentId: expect.stringMatching(/^consent_byok_.{16,}$/),
        storage: {
          application: {
            storesPrompt: true,
            storesResponse: true,
            location: expect.stringMatching(/IndexedDB|local/i),
          },
        },
        trainingUse: {
          status: trainingStatus,
          summary: expect.any(String),
          policyUrl: expect.stringMatching(/^https?:\/\//),
        },
      });
      expect(disclosure.sentData.map((item) => item.category)).toEqual(
        expect.arrayContaining(["prompt", "selected-context", "credential"]),
      );
      expect(disclosure.retention.provider.summary.length).toBeGreaterThan(10);
    },
  );

  it("does not overclaim a provider policy for an arbitrary compatible endpoint", () => {
    const disclosure = createByokAiDataDisclosure("openai-compatible");

    expect(disclosure.trainingUse.status).toBe("depends");
    expect(disclosure.trainingUse.summary).toMatch(/configured|設定/i);
  });
});
