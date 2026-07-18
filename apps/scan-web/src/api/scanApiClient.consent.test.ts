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
