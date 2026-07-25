// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { AiDataDisclosureView } from "./AiDataConsentDialog";
import {
  acceptActiveAiDataConsent,
  declineActiveAiDataConsent,
  getActiveAiDataConsentRequest,
  requestAiDataConsent,
} from "./aiDataConsentBroker";

function disclosure(
  overrides: Partial<AiDataDisclosureView> = {},
): AiDataDisclosureView {
  return {
    schemaVersion: "grimodex/ai-data-disclosure/1",
    policyVersion: "2026-07-19.1",
    route: "byok",
    provider: "openai",
    destination: "https://api.openai.com",
    consentId: "consent_byok_openai_2026_07_19_abcdef",
    usagePolicy: {
      summary: "A user-supplied key sends selected content to the provider.",
      policyUrl: "https://example.com/policy",
    },
    sentData: [
      { category: "prompt", description: "Prompt and selected context" },
    ],
    processingDestinations: [
      {
        processor: "OpenAI API",
        purpose: "Generate the requested assistance",
        location: "Provider-managed infrastructure",
        privacyPolicyUrl: "https://example.com/privacy",
      },
    ],
    storage: {
      application: {
        storesPrompt: false,
        storesResponse: true,
        location: "This browser workspace (IndexedDB)",
      },
      provider: {
        summary: "Provider retention applies.",
        policyUrl: "https://example.com/retention",
      },
    },
    retention: {
      application: { uploadMinutes: 0, sourceDays: 0, artifactDays: 0 },
      provider: {
        summary: "Provider retention applies.",
        policyUrl: "https://example.com/retention",
      },
    },
    trainingUse: {
      status: "not-used",
      summary: "API data is not used for training by default.",
      policyUrl: "https://example.com/training",
    },
    ...overrides,
  };
}

describe("AI data consent broker", () => {
  beforeEach(() => {
    localStorage.clear();
    declineActiveAiDataConsent();
  });

  it("blocks an AI request until the visible disclosure is explicitly accepted", async () => {
    const pending = requestAiDataConsent(disclosure());

    const snapshot = getActiveAiDataConsentRequest();
    expect(snapshot?.disclosure).toMatchObject({
      route: "byok",
      provider: "openai",
    });
    expect(getActiveAiDataConsentRequest()).toBe(snapshot);

    acceptActiveAiDataConsent("consent_byok_openai_2026_07_19_abcdef");
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects without contacting AI when the user declines", async () => {
    const pending = requestAiDataConsent(disclosure());

    declineActiveAiDataConsent();

    await expect(pending).rejects.toThrow("ai-data-consent-required");
  });

  it("reuses current consent but asks again when provider or policy changes", async () => {
    const first = requestAiDataConsent(disclosure());
    acceptActiveAiDataConsent("consent_byok_openai_2026_07_19_abcdef");
    await first;

    await expect(requestAiDataConsent(disclosure())).resolves.toBeUndefined();

    const changed = requestAiDataConsent(
      disclosure({
        provider: "anthropic",
        policyVersion: "2026-07-20.1",
        consentId: "consent_byok_anthropic_2026_07_20_abcdef",
      }),
    );
    expect(getActiveAiDataConsentRequest()?.disclosure.provider).toBe(
      "anthropic",
    );
    declineActiveAiDataConsent();
    await expect(changed).rejects.toThrow("ai-data-consent-required");
  });

  it("ignores consent left by the retired browser-local route", async () => {
    localStorage.setItem(
      "grimodex:ai-data-consents/v1",
      JSON.stringify([
        {
          policyVersion: "2026-07-25.2",
          route: "browser-local",
          provider: "browser-local",
          destination: "browser://local",
          acceptedAt: "2026-07-25T01:02:03.000Z",
        },
      ]),
    );

    const pending = requestAiDataConsent(disclosure());
    expect(getActiveAiDataConsentRequest()?.disclosure.route).toBe("byok");
    declineActiveAiDataConsent();
    await expect(pending).rejects.toThrow("ai-data-consent-required");
  });

  it("authorizes the current request without hanging when consent storage is unavailable", async () => {
    const original = window.localStorage;
    const unavailable = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Storage disabled", "SecurityError");
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    } satisfies Storage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: unavailable,
    });
    try {
      const pending = requestAiDataConsent(disclosure());
      acceptActiveAiDataConsent("consent_byok_openai_2026_07_19_abcdef");

      await expect(pending).resolves.toBeUndefined();
      const next = requestAiDataConsent(disclosure());
      expect(getActiveAiDataConsentRequest()).not.toBeNull();
      declineActiveAiDataConsent();
      await expect(next).rejects.toThrow("ai-data-consent-required");
    } finally {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });
});
