import { describe, expect, it } from "vitest";
import * as scanContract from "../src/index.js";

type DisclosureParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: Array<{ path: string; message: string }> };

const parseAiDataDisclosure = (
  scanContract as unknown as {
    parseAiDataDisclosure?: (value: unknown) => DisclosureParseResult;
  }
).parseAiDataDisclosure;

function validDisclosure(): Record<string, unknown> {
  return {
    schemaVersion: "grimodex/ai-data-disclosure/1",
    policyVersion: "2026-07-19.1",
    route: "hosted-editor",
    provider: "workers-ai",
    consentId: "consent_opaque_server_value_0123456789",
    usagePolicy: {
      summary: "Editor assistance is processed only after explicit consent.",
      policyUrl: "https://try.grimodex.app/ai-policy",
    },
    sentData: [
      {
        category: "prompt",
        description: "The instruction entered by the user",
      },
      {
        category: "selected-context",
        description: "Only the context selected for this request",
      },
    ],
    processingDestinations: [
      {
        processor: "Cloudflare Workers AI",
        purpose: "Generate the requested editor assistance",
        location: "Cloudflare managed infrastructure",
        privacyPolicyUrl: "https://www.cloudflare.com/privacypolicy/",
      },
    ],
    storage: {
      application: {
        storesPrompt: false,
        storesResponse: true,
        location: "Cloudflare R2",
      },
      provider: {
        summary: "Provider-side handling follows the linked provider policy.",
        policyUrl: "https://www.cloudflare.com/privacypolicy/",
      },
    },
    retention: {
      application: {
        uploadMinutes: 60,
        sourceDays: 1,
        artifactDays: 30,
      },
      provider: {
        summary: "See the provider policy for provider-side retention.",
        policyUrl: "https://www.cloudflare.com/privacypolicy/",
      },
    },
    trainingUse: {
      status: "not-used",
      summary: "The hosted route is not used to train Grimodex models.",
      policyUrl: "https://try.grimodex.app/ai-policy",
    },
  };
}

function parse(value: unknown): DisclosureParseResult {
  expect(
    parseAiDataDisclosure,
    "@grimodex/scan-contract must export parseAiDataDisclosure",
  ).toBeTypeOf("function");
  return parseAiDataDisclosure!(value);
}

describe("AiDataDisclosureV1 contract", () => {
  it("accepts a complete, typed disclosure", () => {
    const result = parse(validDisclosure());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        policyVersion: "2026-07-19.1",
        route: "hosted-editor",
        provider: "workers-ai",
      });
    }
  });

  it("accepts only the public scan and hosted-editor routes", () => {
    expect(parse({ ...validDisclosure(), route: "scan" }).ok).toBe(true);
    expect(parse({ ...validDisclosure(), route: "hosted-editor" }).ok).toBe(
      true,
    );
  });

  it.each([
    "policyVersion",
    "route",
    "provider",
    "consentId",
    "usagePolicy",
    "sentData",
    "processingDestinations",
    "storage",
    "retention",
    "trainingUse",
  ])("fails closed when required field %s is missing", (field) => {
    const disclosure = validDisclosure();
    delete disclosure[field];

    const result = parse(disclosure);

    expect(result.ok).toBe(false);
  });

  it("rejects unknown routes and non-opaque consent identifiers", () => {
    const invalidRoute = { ...validDisclosure(), route: "desktop" };
    const invalidConsent = { ...validDisclosure(), consentId: "short" };

    expect(parse(invalidRoute).ok).toBe(false);
    expect(parse(invalidConsent).ok).toBe(false);
  });

  it("rejects disclosure text that omits every concrete data category", () => {
    const disclosure = { ...validDisclosure(), sentData: [] };

    expect(parse(disclosure).ok).toBe(false);
  });

  it("fails closed when nested retention, storage, or training facts are incomplete", () => {
    const missingRetention = validDisclosure();
    delete (
      (missingRetention.retention as Record<string, unknown>)
        .application as Record<string, unknown>
    ).sourceDays;

    const missingStorage = validDisclosure();
    delete (
      (missingStorage.storage as Record<string, unknown>).application as Record<
        string,
        unknown
      >
    ).storesPrompt;

    const missingTraining = validDisclosure();
    delete (missingTraining.trainingUse as Record<string, unknown>).status;

    expect(parse(missingRetention).ok).toBe(false);
    expect(parse(missingStorage).ok).toBe(false);
    expect(parse(missingTraining).ok).toBe(false);
  });
});
