import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanEnv } from "../env";
import { createGatewayAiProvider } from "./gatewayAiProvider";
import { OPENROUTER_ACCOUNT_POLICY_ATTESTATION } from "./openRouterPolicy";

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter frontier contract", () => {
  it("pins Terra to Azure ZDR without unsupported sampling parameters", async () => {
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
        OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "server-only",
        OPENROUTER_ACCOUNT_POLICY_ATTESTATION,
      } as unknown as ScanEnv,
      "openrouter",
      {
        provider: "openrouter",
        model: "openai/gpt-5.6-terra",
        maxInputCharacters: 1_000,
        maxOutputCharacters: 1_000,
        allowFallback: false,
      },
    );
    if (!provider) throw new Error("OpenRouter provider was not configured");

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

    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "openai/gpt-5.6-terra",
      max_completion_tokens: 4_000,
      provider: {
        order: ["azure"],
        only: ["azure"],
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
      usage: { include: true },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer server-only",
    );
    expect(new Headers(init?.headers).get("http-referer")).toBe(
      "https://grimodex.app",
    );
    expect(new Headers(init?.headers).get("x-openrouter-title")).toBe(
      "Grimodex Scan",
    );
    expect(String(init?.body)).not.toContain("server-only");
  });

  it("does not configure a provider without the current account-policy attestation", () => {
    const provider = createGatewayAiProvider(
      {
        OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY: "server-only",
      } as unknown as ScanEnv,
      "openrouter",
      {
        provider: "openrouter",
        model: "openai/gpt-5.6-terra",
        maxInputCharacters: 1_000,
        maxOutputCharacters: 1_000,
        allowFallback: false,
      },
    );

    expect(provider).toBeNull();
  });
});
