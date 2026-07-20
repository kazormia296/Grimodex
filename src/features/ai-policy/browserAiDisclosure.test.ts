import { describe, expect, it } from "vitest";
import {
  BROWSER_AI_DATA_POLICY_VERSION,
  createByokAiDataDisclosure,
} from "./browserAiDisclosure";

describe("browser BYOK AI disclosure", () => {
  it.each([
    ["openai", "not-used"],
    ["anthropic", "not-used"],
    ["ollama", "depends"],
  ] as const)(
    "explains sent data, local storage, retention, and training for %s",
    (provider, trainingStatus) => {
      const disclosure = createByokAiDataDisclosure(provider, { locale: "en" });

      expect(disclosure).toMatchObject({
        schemaVersion: "grimodex/ai-data-disclosure/1",
        policyVersion: BROWSER_AI_DATA_POLICY_VERSION,
        route: "byok",
        provider,
        destination: expect.stringMatching(/^https?:\/\//),
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
        expect.arrayContaining(["prompt", "selected-context"]),
      );
      expect(
        disclosure.sentData.some((item) => item.category === "credential"),
      ).toBe(provider !== "ollama");
      expect(disclosure.retention.provider.summary.length).toBeGreaterThan(10);
      expect(JSON.stringify(disclosure)).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    },
  );

  it("binds Ollama consent and disclosure to the exact configured endpoint", () => {
    const first = createByokAiDataDisclosure("ollama", {
      locale: "ja",
      ollamaEndpoint: "http://192.0.2.10:11434/",
    });
    const second = createByokAiDataDisclosure("ollama", {
      locale: "ja",
      ollamaEndpoint: "http://192.0.2.11:11434",
    });

    expect(first.destination).toBe("http://192.0.2.10:11434");
    expect(first.processingDestinations[0]?.location).toBe(
      "http://192.0.2.10:11434",
    );
    expect(first.consentId).not.toBe(second.consentId);
  });

  it("fails closed for a provider outside the Web Editor allowlist", () => {
    expect(() =>
      createByokAiDataDisclosure("openai-compatible", { locale: "en" }),
    ).toThrow(/not supported/i);
  });
});
