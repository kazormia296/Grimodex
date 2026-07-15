import { describe, expect, it, vi } from "vitest";
import { HostedAiClient, HOSTED_AI_COST_WEIGHT } from "./hostedAiClient";

describe("HostedAiClient", () => {
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
        { operation: "inline", prompt: "Rewrite this" },
      ),
    ).resolves.toEqual({ response: "ok", costWeight: 2 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://scan.example/api/v1/scans/scan%2F1/editor-ai",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-scan-token": "secret",
    });
    expect(HOSTED_AI_COST_WEIGHT).toEqual({ chat: 1, inline: 2, codex: 3 });
  });
});
