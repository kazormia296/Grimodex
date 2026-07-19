import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanEnv } from "../env";
import { createGatewayAiProvider } from "./gatewayAiProvider";
import { PROVIDER_CALL_TIMEOUT_MS } from "./workersAiProvider";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("gateway AI provider", () => {
  it("rejects redirects so a provider cannot forward its bearer token", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schemaVersion: "grimodex-scan/chunk-extraction/1",
                  chunkId: "chunk:test",
                  sourceFingerprint: "sha256:test",
                  entities: [],
                  relations: [],
                  events: [],
                }),
              },
            },
          ],
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createGatewayAiProvider(
      {
        SCAN_AI_GATEWAY_URL: "https://gateway.example/v1/chat/completions",
        AI_GATEWAY_TOKEN: "server-only",
      } as unknown as ScanEnv,
      "ai-gateway",
      {
        provider: "ai-gateway",
        model: "test-model",
        maxInputCharacters: 1_000,
        maxOutputCharacters: 1_000,
        allowFallback: false,
      },
    );
    if (!provider) throw new Error("test provider was not configured");

    await provider.extractChunk({
      language: "ja",
      chunkId: "chunk:test",
      sourceFingerprint: "sha256:test",
      text: "本文",
      sectionIds: ["section:test"],
      paragraphIds: ["paragraph:test"],
      paragraphSectionIds: { "paragraph:test": "section:test" },
      paragraphs: [
        {
          paragraphId: "paragraph:test",
          sectionId: "section:test",
          text: "本文",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer server-only",
    });
  });

  it("aborts a gateway response body that never settles", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        json: () => new Promise<never>(() => undefined),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createGatewayAiProvider(
      {
        SCAN_AI_GATEWAY_URL: "https://gateway.example/v1/chat/completions",
        AI_GATEWAY_TOKEN: "server-only",
      } as unknown as ScanEnv,
      "ai-gateway",
      {
        provider: "ai-gateway",
        model: "test-model",
        maxInputCharacters: 1_000,
        maxOutputCharacters: 1_000,
        allowFallback: false,
      },
    );
    if (!provider) throw new Error("test provider was not configured");

    const pending = provider.extractChunk({
      language: "ja",
      chunkId: "chunk:test",
      sourceFingerprint: "sha256:test",
      text: "本文",
      sectionIds: ["section:test"],
      paragraphIds: ["paragraph:test"],
      paragraphSectionIds: { "paragraph:test": "section:test" },
      paragraphs: [
        {
          paragraphId: "paragraph:test",
          sectionId: "section:test",
          text: "本文",
        },
      ],
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(PROVIDER_CALL_TIMEOUT_MS);

    await rejection;
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });
});
