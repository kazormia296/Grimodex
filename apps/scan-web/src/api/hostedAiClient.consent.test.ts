import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_CONTENT_POLICY_ACK_HEADER,
  CLOUD_CONTENT_POLICY_VERSION,
} from "@grimodex/scan-contract";
import { HostedAiClient } from "./hostedAiClient";

type CompleteInput = Parameters<HostedAiClient["complete"]>[1];

describe("HostedAiClient AI data consent", () => {
  it("sends the opaque consent identity as a header, never in the prompt body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ response: "ok", costWeight: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new HostedAiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
    });
    const input: CompleteInput & { consentId: string } = {
      operation: "chat",
      prompt: "Private manuscript text",
      idempotencyKey: "hosted-consent-request-123456",
      consentId: "consent_opaque_policy_route_provider_123456",
    };

    await client.complete({ scanId: "scan-1", scanToken: "scan-token" }, input);

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-ai-consent-id": "consent_opaque_policy_route_provider_123456",
      [CLOUD_CONTENT_POLICY_ACK_HEADER]: CLOUD_CONTENT_POLICY_VERSION,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      operation: "chat",
      prompt: "Private manuscript text",
    });
  });

  it("fails closed before the network when no consent identity is supplied", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new HostedAiClient({
      baseUrl: "https://scan.example",
      fetchImpl,
    });
    const inputWithoutConsent = {
      operation: "chat",
      prompt: "Private manuscript text",
      idempotencyKey: "hosted-consent-request-123456",
    } as CompleteInput;

    await expect(
      client.complete(
        { scanId: "scan-1", scanToken: "scan-token" },
        inputWithoutConsent,
      ),
    ).rejects.toThrow(/consent/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
