import { describe, expect, it } from "vitest";
import type { ScanEnv } from "./env";
import { currentAiDataConsentIdentity } from "./ai/aiDataDisclosure";
import { OPENROUTER_ACCOUNT_POLICY_ATTESTATION } from "./ai/openRouterPolicy";
import { handleRequest } from "./router";

function env(overrides: Partial<ScanEnv> = {}): ScanEnv {
  return {
    DB: {
      prepare: () => {
        throw new Error("database should not be touched");
      },
      batch: async () => [],
    },
    SCAN_BUCKET: {
      put: async () => undefined,
      get: async () => null,
      head: async () => null,
      delete: async () => undefined,
    },
    AI: { run: async () => ({ response: "unused" }) },
    SCAN_AI_PROVIDER: "workers-ai",
    SCAN_AI_MODEL: "@cf/zai-org/glm-4.7-flash",
    SCAN_WORKERS_AI_ENABLED: "true",
    SCAN_FRONTIER_ENABLED: "true",
    SCAN_FRONTIER_PROVIDER: "openrouter",
    SCAN_FRONTIER_MODEL: "openai/gpt-5.6-terra",
    SCAN_EDITOR_AI_PROVIDER: "openrouter",
    SCAN_EDITOR_AI_MODEL: "openai/gpt-5.6-luna",
    OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
    OPENROUTER_API_KEY: "server-only",
    OPENROUTER_ACCOUNT_POLICY_ATTESTATION,
    ...overrides,
  } as ScanEnv;
}

describe("OpenRouter data disclosure", () => {
  it("discloses the Workers AI -> OpenRouter -> Azure Full Scan chain", async () => {
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/ai-disclosures/scan?locale=ja"),
      env(),
    );
    const body = (await response.json()) as {
      provider: string;
      processingDestinations: Array<{ processor: string }>;
      storage: { provider: { summary: string } };
      retention: { provider: { summary: string } };
      trainingUse: { status: string; summary: string };
    };

    expect(response.status).toBe(200);
    expect(body.provider).toBe(
      "workers-ai+openrouter:global:azure-zdr-account-attested-v2:openai/gpt-5.6-terra",
    );
    expect(
      body.processingDestinations.map(({ processor }) => processor),
    ).toEqual(["Cloudflare Workers AI", "OpenRouter", "Microsoft Azure AI"]);
    expect(body.storage.provider.summary).toContain("メタデータ");
    expect(body.storage.provider.summary).toContain("Broadcast");
    expect(body.retention.provider.summary).toContain("最低3か月");
    expect(body.trainingUse.status).toBe("depends");
    expect(body.trainingUse.summary).toContain("Input/Output Logging");
    expect(body.trainingUse.summary).toContain("Use of Inputs/Outputs");
  });

  it("keeps Hosted Editor disclosure on Luna and renews consent on model or endpoint changes", async () => {
    const response = await handleRequest(
      new Request(
        "https://scan.example/api/v1/ai-disclosures/hosted-editor?locale=en",
      ),
      env(),
    );
    const body = (await response.json()) as {
      provider: string;
      consentId: string;
      processingDestinations: Array<{ processor: string }>;
    };
    const terraIdentity = await currentAiDataConsentIdentity(
      env({ SCAN_EDITOR_AI_MODEL: "openai/gpt-5.6-terra" }),
      "hosted-editor",
    );
    const euIdentity = await currentAiDataConsentIdentity(
      env({
        OPENROUTER_URL: "https://eu.openrouter.ai/api/v1/chat/completions",
      }),
      "hosted-editor",
    );

    expect(response.status).toBe(200);
    expect(body.provider).toBe(
      "openrouter:global:azure-zdr-account-attested-v2:openai/gpt-5.6-luna",
    );
    expect(
      body.processingDestinations.map(({ processor }) => processor),
    ).toEqual(["OpenRouter", "Microsoft Azure AI"]);
    expect(terraIdentity.consentId).not.toBe(body.consentId);
    expect(euIdentity.consentId).not.toBe(body.consentId);
  });

  it("fails closed when the OpenRouter account-policy review is absent or stale", async () => {
    for (const attestation of [undefined, "2026-07-19.8:stale"]) {
      const response = await handleRequest(
        new Request(
          "https://scan.example/api/v1/ai-disclosures/hosted-editor?locale=en",
        ),
        env({ OPENROUTER_ACCOUNT_POLICY_ATTESTATION: attestation }),
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "ai_disclosure_unavailable" },
      });
    }
  });
});
