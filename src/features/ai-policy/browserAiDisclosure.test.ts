import { describe, expect, it } from "vitest";
import {
  BROWSER_AI_DATA_POLICY_VERSION,
  createByokAiDataDisclosure,
} from "./browserAiDisclosure";

describe("browser BYOK AI disclosure", () => {
  it.each([
    ["openrouter", "depends"],
    ["openai", "not-used"],
    ["anthropic", "not-used"],
    ["ollama", "depends"],
    ["openai-compatible", "depends"],
    ["sakana", "depends"],
    ["ai-novelist", "depends"],
  ] as const)(
    "explains sent data, local storage, retention, and training for %s",
    (provider, trainingStatus) => {
      const disclosure = createByokAiDataDisclosure(provider, {
        locale: "en",
        ...(provider === "openai-compatible"
          ? { baseUrl: "https://gateway.example/v1" }
          : {}),
      });

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
      const providerRequiresCredential =
        provider !== "ollama" && provider !== "openai-compatible";
      expect(
        disclosure.sentData.some((item) => item.category === "credential"),
      ).toBe(providerRequiresCredential);
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

  it("binds custom endpoint consent to the normalized actual destination", () => {
    const first = createByokAiDataDisclosure("openai-compatible", {
      locale: "en",
      baseUrl: "https://gateway.example/v1/",
    });
    const second = createByokAiDataDisclosure("openai-compatible", {
      locale: "en",
      baseUrl: "https://other.example/v1",
    });

    expect(first.destination).toBe("https://gateway.example/v1");
    expect(first.processingDestinations[0]?.location).toBe(
      "https://gateway.example/v1",
    );
    expect(first.consentId).not.toBe(second.consentId);
    expect(first.sentData.some((item) => item.category === "credential")).toBe(
      false,
    );
  });

  it("fails closed for native CLI", () => {
    expect(() => createByokAiDataDisclosure("cli", { locale: "en" })).toThrow(
      /not supported/i,
    );
  });

  it("describes WebGPU inference as browser-local instead of Ollama network processing", () => {
    const disclosure = createByokAiDataDisclosure("ollama", {
      locale: "en",
      browserAiMode: "webgpu",
    });

    expect(disclosure).toMatchObject({
      provider: "browser-local",
      destination: "browser://local",
      trainingUse: { status: "not-used" },
    });
    expect(disclosure.sentData).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "credential" }),
      ]),
    );
  });
});
