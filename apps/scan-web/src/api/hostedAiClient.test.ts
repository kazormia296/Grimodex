import { describe, expect, it, vi } from "vitest";
import { HostedAiClient, HOSTED_AI_COST_WEIGHT } from "./hostedAiClient";

describe("HostedAiClient", () => {
  it("binds the browser fetch receiver when no fetch implementation is injected", async () => {
    const receiverSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(
        new Response(JSON.stringify({ response: "ok", costWeight: 1 }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal("fetch", receiverSensitiveFetch);

    try {
      const client = new HostedAiClient({
        baseUrl: "https://scan.example",
      });

      await expect(
        client.complete(
          { scanId: "scan-1", scanToken: "secret" },
          {
            operation: "chat",
            prompt: "Continue",
            idempotencyKey: "request-12345678",
            consentId: "consent_current_hosted_editor_policy_123456",
          },
        ),
      ).resolves.toEqual({ response: "ok", costWeight: 1 });
      expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the scan access token header and exposes operation cost weights", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ response: "ok", costWeight: 2 }), {
          status: 200,
        }),
    );
    const client = new HostedAiClient({
      baseUrl: "https://scan.example/",
      fetchImpl,
    });
    await expect(
      client.complete(
        { scanId: "scan/1", scanToken: "secret" },
        {
          operation: "inline",
          prompt: "Rewrite this",
          idempotencyKey: "request-12345678",
          consentId: "consent_current_hosted_editor_policy_123456",
        },
      ),
    ).resolves.toEqual({ response: "ok", costWeight: 2 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://scan.example/api/v1/scans/scan%2F1/editor-ai",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-scan-token": "secret",
      "x-idempotency-key": "request-12345678",
      "x-ai-consent-id": "consent_current_hosted_editor_policy_123456",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      operation: "inline",
      prompt: "Rewrite this",
    });
    expect(HOSTED_AI_COST_WEIGHT).toEqual({ chat: 1, inline: 2, codex: 3 });
  });
});
