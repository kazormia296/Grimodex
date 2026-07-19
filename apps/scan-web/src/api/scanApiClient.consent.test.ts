import { describe, expect, it, vi } from "vitest";
import { ScanApiClient } from "./scanApiClient";

type UploadIntentInput = Parameters<ScanApiClient["createUploadIntent"]>[0];

function uploadIntentResponse(): Response {
  return new Response(
    JSON.stringify({
      uploadId: "upload-1",
      uploadUrl: "https://scan.example/api/v1/uploads/upload-1",
      uploadToken: "upload-token",
      expiresAt: "2026-07-19T01:00:00.000Z",
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

describe("ScanApiClient AI data consent", () => {
  it("loads and validates the current public disclosure before any upload", async () => {
    const disclosure = {
      schemaVersion: "grimodex/ai-data-disclosure/1",
      policyVersion: "2026-07-19.1",
      route: "scan",
      provider: "workers-ai",
      consentId: "consent_scan_workers_ai_2026_07_19_abcdef",
      usagePolicy: {
        summary: "Explicit consent is required.",
        policyUrl: "https://example.com/policy",
      },
      sentData: [{ category: "source", description: "Manuscript" }],
      processingDestinations: [
        {
          processor: "Cloudflare Workers AI",
          purpose: "Scan",
          location: "Cloudflare managed infrastructure",
          privacyPolicyUrl: "https://example.com/privacy",
        },
      ],
      storage: {
        application: {
          storesPrompt: true,
          storesResponse: true,
          location: "Cloudflare R2 and D1",
        },
        provider: {
          summary: "Provider policy applies.",
          policyUrl: "https://example.com/provider",
        },
      },
      retention: {
        application: { uploadMinutes: 60, sourceDays: 1, artifactDays: 30 },
        provider: {
          summary: "Provider retention applies.",
          policyUrl: "https://example.com/provider",
        },
      },
      trainingUse: {
        status: "not-used",
        summary: "Not used for training.",
        policyUrl: "https://example.com/training",
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(disclosure),
    );
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
    });

    await expect(client.getAiDisclosure("scan", "ja")).resolves.toEqual(
      disclosure,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://scan.example/api/v1/ai-disclosures/scan?locale=ja",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("authorizes an upload with the opaque consent header without copying it into JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => uploadIntentResponse());
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
    });
    const input: UploadIntentInput & { consentId: string } = {
      filename: "private-manuscript.txt",
      contentType: "text/plain",
      size: 128,
      consentId: "consent_opaque_policy_route_provider_123456",
    };

    await client.createUploadIntent(input);

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-ai-consent-id": "consent_opaque_policy_route_provider_123456",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      filename: "private-manuscript.txt",
      contentType: "text/plain",
      size: 128,
    });
  });

  it("fails closed before the network when an upload has no consent identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new ScanApiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
    });
    const inputWithoutConsent = {
      filename: "private-manuscript.txt",
      contentType: "text/plain",
      size: 128,
    } as UploadIntentInput;

    await expect(
      client.createUploadIntent(inputWithoutConsent),
    ).rejects.toThrow(/consent/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
