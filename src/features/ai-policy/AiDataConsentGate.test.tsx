// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { AiDataDisclosureView } from "./AiDataConsentDialog";
import { AiDataConsentGate } from "./AiDataConsentGate";
import {
  declineActiveAiDataConsent,
  requestAiDataConsent,
} from "./aiDataConsentBroker";

const disclosure: AiDataDisclosureView = {
  schemaVersion: "grimodex/ai-data-disclosure/1",
  policyVersion: "2026-07-19.1",
  route: "byok",
  provider: "openai",
  destination: "https://api.openai.com",
  consentId: "consent_byok_openai_2026_07_19_abcdef",
  usagePolicy: {
    summary: "Selected content is sent only after consent.",
    policyUrl: "https://example.com/policy",
  },
  sentData: [{ category: "prompt", description: "Prompt and context" }],
  processingDestinations: [
    {
      processor: "OpenAI API",
      purpose: "Generate assistance",
      location: "Provider-managed infrastructure",
      privacyPolicyUrl: "https://example.com/privacy",
    },
  ],
  storage: {
    application: {
      storesPrompt: true,
      storesResponse: true,
      location: "Browser IndexedDB",
    },
    provider: {
      summary: "Provider policy applies.",
      policyUrl: "https://example.com/storage",
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
    summary: "Not used by default.",
    policyUrl: "https://example.com/training",
  },
};

describe("AiDataConsentGate", () => {
  beforeEach(() => {
    localStorage.clear();
    declineActiveAiDataConsent();
  });

  it("renders one stable disclosure while the provider call is blocked", async () => {
    render(<AiDataConsentGate />);
    let pending: Promise<void> | undefined;

    await act(async () => {
      pending = requestAiDataConsent(disclosure);
    });

    expect(
      screen.getByRole("dialog", { name: "AIへ送信する前に確認" }),
    ).toBeTruthy();
    act(() => declineActiveAiDataConsent());
    await expect(pending).rejects.toThrow("ai-data-consent-required");
  });
});
