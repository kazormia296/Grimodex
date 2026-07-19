import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanEnv } from "./env";
import { ScanRepository } from "./repository";
import { handleRequest } from "./router";
import { currentAiDataConsentIdentity } from "./ai/aiDataDisclosure";
import { sha256Hex } from "./security";

afterEach(() => {
  vi.restoreAllMocks();
});

function env(overrides: Partial<ScanEnv> = {}): ScanEnv {
  return {
    DB: {
      prepare: () => {
        throw new Error("database should not be touched by this test");
      },
      batch: async () => [],
    },
    SCAN_BUCKET: {
      put: async () => undefined,
      get: async () => null,
      head: async () => null,
      delete: async () => undefined,
    },
    ...overrides,
  };
}

const completedScan = {
  id: "scan-1",
  uploadId: "upload-1",
  mode: "quick" as const,
  status: "completed" as const,
  sourceHash: "source-hash",
  privateBundleKey: "artifacts/scan-1/bundle.json",
  privateReportKey: "artifacts/scan-1/report.json",
  cancelRequestedAt: null,
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
  accessTokenHash: "scan-token-hash",
};

describe("public AI data disclosures", () => {
  it.each(["scan", "hosted-editor"] as const)(
    "publishes the workers-ai %s disclosure with the configured retention",
    async (route) => {
      const response = await handleRequest(
        new Request(`https://scan.example/api/v1/ai-disclosures/${route}`),
        env({
          AI: { run: vi.fn(async () => ({ response: "unused" })) },
          SCAN_AI_PROVIDER: "workers-ai",
          SCAN_WORKERS_AI_ENABLED: "true",
          SCAN_UPLOAD_RETENTION_MINUTES: "37",
          SCAN_SOURCE_RETENTION_DAYS: "2",
          SCAN_RETENTION_DAYS: "45",
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({
        schemaVersion: "grimodex/ai-data-disclosure/1",
        policyVersion: expect.any(String),
        route,
        provider: "workers-ai",
        consentId: expect.stringMatching(/^consent_[A-Za-z0-9_-]{16,}$/),
        usagePolicy: {
          summary: expect.any(String),
          policyUrl: expect.any(String),
        },
        sentData: expect.arrayContaining([
          expect.objectContaining({
            category: expect.any(String),
            description: expect.any(String),
          }),
        ]),
        processingDestinations: expect.arrayContaining([
          expect.objectContaining({
            processor: "Cloudflare Workers AI",
            purpose: expect.any(String),
            privacyPolicyUrl: expect.any(String),
          }),
        ]),
        storage: {
          application: {
            storesPrompt: expect.any(Boolean),
            storesResponse: expect.any(Boolean),
            location: expect.any(String),
          },
          provider: {
            summary: expect.any(String),
            policyUrl: expect.any(String),
          },
        },
        retention: {
          application: {
            uploadMinutes: 37,
            sourceDays: 2,
            artifactDays: 45,
          },
          provider: {
            summary: expect.any(String),
            policyUrl: expect.any(String),
          },
        },
        trainingUse: {
          status: expect.any(String),
          summary: expect.any(String),
          policyUrl: expect.any(String),
        },
      });
    },
  );

  it("localizes disclosure text and the Grimodex privacy notice without changing consent identity", async () => {
    const configured = env({
      AI: { run: vi.fn(async () => ({ response: "unused" })) },
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_WORKERS_AI_ENABLED: "true",
    });
    const [japaneseResponse, englishResponse] = await Promise.all([
      handleRequest(
        new Request(
          "https://scan.example/api/v1/ai-disclosures/scan?locale=ja",
        ),
        configured,
      ),
      handleRequest(
        new Request(
          "https://scan.example/api/v1/ai-disclosures/scan?locale=en",
        ),
        configured,
      ),
    ]);
    const japanese = (await japaneseResponse.json()) as {
      consentId: string;
      usagePolicy: { summary: string; policyUrl: string };
      sentData: Array<{ category: string; description: string }>;
      storage: { application: { location: string } };
      trainingUse: { summary: string };
    };
    const english = (await englishResponse.json()) as typeof japanese;

    expect(japaneseResponse.status).toBe(200);
    expect(englishResponse.status).toBe(200);
    expect(japanese.consentId).toBe(english.consentId);
    expect(japanese.usagePolicy.policyUrl).toBe(
      "https://try.grimodex.app/PRIVACY_ja.md",
    );
    expect(english.usagePolicy.policyUrl).toBe(
      "https://try.grimodex.app/PRIVACY_en.md",
    );
    expect(japanese.usagePolicy.summary).toMatch(/[ぁ-んァ-ヶ一-龯]/u);
    expect(japanese.sentData[0]?.description).toMatch(/[ぁ-んァ-ヶ一-龯]/u);
    expect(japanese.storage.application.location).toMatch(/[ぁ-んァ-ヶ一-龯]/u);
    expect(japanese.trainingUse.summary).toMatch(/[ぁ-んァ-ヶ一-龯]/u);
    expect(english.usagePolicy.summary).toMatch(/explicit consent/i);
    expect(english.sentData[0]?.category).toBe("manuscript");
  });

  it("states that AI-disabled Scan is deterministic and sends no manuscript data to an external AI model", async () => {
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/ai-disclosures/scan?locale=en"),
      env({
        SCAN_ENVIRONMENT: "development",
        SCAN_AI_PROVIDER: "workers-ai",
        SCAN_WORKERS_AI_ENABLED: "false",
        SCAN_FRONTIER_ENABLED: "false",
      }),
    );
    const body = (await response.json()) as {
      provider: string;
      usagePolicy: { summary: string };
      processingDestinations: Array<{ processor: string; purpose: string }>;
      trainingUse: { status: string; summary: string };
    };

    expect(response.status).toBe(200);
    expect(body.provider).toMatch(/deterministic/i);
    expect(body.usagePolicy.summary).toMatch(/no external AI model/i);
    expect(body.processingDestinations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ processor: expect.stringMatching(/AI/i) }),
      ]),
    );
    expect(body.trainingUse).toMatchObject({ status: "not-used" });
    expect(body.trainingUse.summary).toMatch(
      /not sent to an external AI model/i,
    );
  });

  it("does not invent disclosures for unknown processing routes", async () => {
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/ai-disclosures/desktop"),
      env({
        AI: { run: vi.fn(async () => ({ response: "unused" })) },
        SCAN_AI_PROVIDER: "workers-ai",
        SCAN_WORKERS_AI_ENABLED: "true",
      }),
    );

    expect(response.status).toBe(404);
  });

  it.each(["scan", "hosted-editor"] as const)(
    "discloses R2 content storage, D1 non-content hashes, and the %s retention caveat",
    async (route) => {
      const response = await handleRequest(
        new Request(`https://scan.example/api/v1/ai-disclosures/${route}`),
        env({
          AI: { run: vi.fn(async () => ({ response: "unused" })) },
          SCAN_AI_PROVIDER: "workers-ai",
          SCAN_WORKERS_AI_ENABLED: "true",
        }),
      );
      const body = (await response.json()) as {
        storage: { application: { location: string } };
      };
      const location = body.storage.application.location;

      expect(response.status).toBe(200);
      expect(location).toContain("R2");
      expect(location).toContain("D1");
      expect(location).toMatch(/non-content operational metadata/i);
      expect(location).toMatch(/token hashes/i);
      expect(location).toMatch(/request and idempotency hashes/i);
      expect(location).toMatch(/operational or legal retention requirements/i);
    },
  );

  it("discloses the complete Workers AI -> AI Gateway -> OpenAI chain when Full Scan frontier processing is enabled", async () => {
    const fullEnv = env({
      AI: { run: vi.fn(async () => ({ response: "unused" })) },
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_WORKERS_AI_ENABLED: "true",
      SCAN_FRONTIER_ENABLED: "true",
      SCAN_FRONTIER_PROVIDER: "ai-gateway",
      SCAN_AI_GATEWAY_URL:
        "https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions",
      AI_GATEWAY_TOKEN: "server-only",
    });
    const quickEnv = env({
      AI: { run: vi.fn(async () => ({ response: "unused" })) },
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_WORKERS_AI_ENABLED: "true",
      SCAN_FRONTIER_ENABLED: "false",
    });

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/ai-disclosures/scan"),
      fullEnv,
    );
    const quickResponse = await handleRequest(
      new Request("https://scan.example/api/v1/ai-disclosures/scan"),
      quickEnv,
    );
    const body = (await response.json()) as {
      policyVersion: string;
      provider: string;
      consentId: string;
      processingDestinations: Array<{ processor: string }>;
      retention: { provider: { summary: string } };
      trainingUse: { status: string; summary: string };
    };
    const quickBody = (await quickResponse.json()) as { consentId: string };

    expect(response.status).toBe(200);
    expect(body.provider).toBe("workers-ai+ai-gateway:openai");
    expect(
      body.processingDestinations.map(({ processor }) => processor),
    ).toEqual(["Cloudflare Workers AI", "Cloudflare AI Gateway", "OpenAI API"]);
    expect(body.retention.provider.summary).toContain("30 days");
    expect(body.trainingUse).toMatchObject({ status: "depends" });
    expect(body.trainingUse.summary).toContain("OpenAI API");
    expect(body.consentId).not.toBe(quickBody.consentId);
  });

  it("keeps hosted Editor disclosure scoped to its primary provider when the Scan frontier is enabled", async () => {
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/ai-disclosures/hosted-editor"),
      env({
        AI: { run: vi.fn(async () => ({ response: "unused" })) },
        SCAN_AI_PROVIDER: "workers-ai",
        SCAN_WORKERS_AI_ENABLED: "true",
        SCAN_FRONTIER_ENABLED: "true",
        SCAN_FRONTIER_PROVIDER: "ai-gateway",
        SCAN_AI_GATEWAY_URL:
          "https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions",
      }),
    );
    const body = (await response.json()) as {
      policyVersion: string;
      provider: string;
      sentData: Array<{ category: string; description: string }>;
      processingDestinations: Array<{ processor: string }>;
      storage: {
        application: {
          storesPrompt: boolean;
          storesResponse: boolean;
          location: string;
        };
      };
      trainingUse: { status: string };
    };

    expect(response.status).toBe(200);
    expect(body.policyVersion).toBe("2026-07-19.5");
    expect(body.provider).toBe("workers-ai");
    expect(body.processingDestinations).toHaveLength(1);
    expect(body.processingDestinations[0]?.processor).toBe(
      "Cloudflare Workers AI",
    );
    expect(body.sentData.map(({ category }) => category)).toEqual([
      "prompt",
      "system-instructions",
      "conversation-history",
      "tool-definitions",
      "selected-context",
    ]);
    expect(
      body.sentData.find(({ category }) => category === "conversation-history")
        ?.description,
    ).toContain("tool-result");
    expect(
      body.sentData.find(({ category }) => category === "tool-definitions")
        ?.description,
    ).toContain("input JSON schemas");
    expect(body.storage.application).toMatchObject({
      storesPrompt: true,
      storesResponse: true,
    });
    expect(body.storage.application.location).toContain("IndexedDB");
    expect(body.storage.application.location).toContain("R2");
    expect(body.trainingUse.status).toBe("not-used");
  });

  it("fails closed instead of claiming no training when an AI Gateway upstream is unknown", async () => {
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/ai-disclosures/scan"),
      env({
        AI: { run: vi.fn(async () => ({ response: "unused" })) },
        SCAN_AI_PROVIDER: "workers-ai",
        SCAN_WORKERS_AI_ENABLED: "true",
        SCAN_FRONTIER_ENABLED: "true",
        SCAN_FRONTIER_PROVIDER: "ai-gateway",
        SCAN_AI_GATEWAY_URL:
          "https://gateway.ai.cloudflare.com/v1/account/gateway/custom/chat/completions",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ai_disclosure_unavailable" },
    });
  });
});

describe("AI data consent enforcement", () => {
  it("persists only the current server-derived identity when issuing an upload intent", async () => {
    const configured = env({
      AI: { run: vi.fn(async () => ({ response: "unused" })) },
      SCAN_ACCEPTING_NEW_JOBS: "true",
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_WORKERS_AI_ENABLED: "true",
    });
    const identity = await currentAiDataConsentIdentity(configured, "scan");
    const createUploadIntent = vi
      .spyOn(ScanRepository.prototype, "createUploadIntent")
      .mockResolvedValue(undefined);

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/upload-intents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ai-consent-id": identity.consentId,
        },
        body: JSON.stringify({
          filename: "private-manuscript.txt",
          contentType: "text/plain",
          size: 128,
          aiConsentProvider: "attacker-controlled",
        }),
      }),
      configured,
    );

    expect(response.status).toBe(201);
    expect(createUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ aiConsent: identity }),
    );
  });

  it.each([
    ["missing", undefined],
    ["non-matching", "consent_wrong_policy_route_or_provider_123456"],
  ] as const)(
    "rejects an upload intent with %s consent before accepting manuscript data",
    async (_label, consentId) => {
      const headers = new Headers({ "content-type": "application/json" });
      if (consentId) headers.set("x-ai-consent-id", consentId);

      const response = await handleRequest(
        new Request("https://scan.example/api/v1/upload-intents", {
          method: "POST",
          headers,
          body: JSON.stringify({
            filename: "private-manuscript.txt",
            contentType: "text/plain",
            size: 128,
          }),
        }),
        env({
          AI: { run: vi.fn(async () => ({ response: "unused" })) },
          SCAN_ACCEPTING_NEW_JOBS: "true",
          SCAN_AI_PROVIDER: "workers-ai",
          SCAN_WORKERS_AI_ENABLED: "true",
        }),
      );

      expect(response.status).toBe(428);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "ai_consent_required" },
      });
    },
  );

  it.each([
    ["missing", undefined],
    ["non-matching", "consent_wrong_policy_route_or_provider_123456"],
  ] as const)(
    "rejects hosted editor AI with %s consent before calling the provider",
    async (_label, consentId) => {
      vi.spyOn(ScanRepository.prototype, "authorizeScan").mockResolvedValue(
        completedScan,
      );
      vi.spyOn(ScanRepository.prototype, "getScan").mockResolvedValue(
        completedScan,
      );
      vi.spyOn(
        ScanRepository.prototype,
        "getAiUsageOperation",
      ).mockResolvedValue(null);
      vi.spyOn(
        ScanRepository.prototype,
        "claimAndReserveAiUsage",
      ).mockResolvedValue({ claimed: true, operation: null });
      vi.spyOn(
        ScanRepository.prototype,
        "finalizeAiUsageOperation",
      ).mockResolvedValue(undefined);
      const aiRun = vi.fn(async () => ({ response: "must not run" }));
      const headers = new Headers({
        "content-type": "application/json",
        "x-idempotency-key": "consent-gate-request-123456",
        "x-scan-token": "scan-token",
      });
      if (consentId) headers.set("x-ai-consent-id", consentId);

      const response = await handleRequest(
        new Request("https://scan.example/api/v1/scans/scan-1/editor-ai", {
          method: "POST",
          headers,
          body: JSON.stringify({ operation: "chat", prompt: "Private text" }),
        }),
        env({
          AI: { run: aiRun },
          SCAN_AI_PROVIDER: "workers-ai",
          SCAN_WORKERS_AI_ENABLED: "true",
          SCAN_EDITOR_AI_ENABLED: "true",
        }),
      );

      expect(response.status).toBe(428);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "ai_consent_required" },
      });
      expect(aiRun).not.toHaveBeenCalled();
    },
  );

  it("rejects source bytes when the accepted provider identity is no longer current", async () => {
    const acceptedEnv = env({
      AI: { run: vi.fn(async () => ({ response: "unused" })) },
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_WORKERS_AI_ENABLED: "true",
    });
    const accepted = await currentAiDataConsentIdentity(acceptedEnv, "scan");
    const put = vi.fn(async () => undefined);
    const releaseUploadClaim = vi
      .spyOn(ScanRepository.prototype, "releaseUploadClaim")
      .mockResolvedValue(undefined);
    vi.spyOn(ScanRepository.prototype, "authorizeUpload").mockResolvedValue({
      id: "upload-1",
      tokenHash: "token-hash",
      filename: "private.txt",
      contentType: "text/plain",
      expectedSize: 7,
      sourceKey: "incoming/upload-1/source.txt",
      status: "uploaded",
      expiresAt: "2026-07-19T00:15:00.000Z",
      actualSize: null,
      sourceHash: null,
      aiConsent: accepted,
    });

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/uploads/upload-1", {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "x-upload-token": "upload-token",
        },
        body: "private",
      }),
      env({
        SCAN_AI_PROVIDER: "openrouter",
        OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
        SCAN_BUCKET: {
          put,
          get: async () => null,
          head: async () => null,
          delete: async () => undefined,
        },
      }),
    );

    expect(response.status).toBe(428);
    expect(put).not.toHaveBeenCalled();
    expect(releaseUploadClaim).toHaveBeenCalledWith("upload-1");
  });

  it("does not queue a scan after the accepted provider identity changes", async () => {
    const uploadToken = "upload-token";
    const secret = "test-secret";
    const acceptedEnv = env({
      AI: { run: vi.fn(async () => ({ response: "unused" })) },
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_WORKERS_AI_ENABLED: "true",
    });
    const accepted = await currentAiDataConsentIdentity(acceptedEnv, "scan");
    vi.spyOn(ScanRepository.prototype, "getUploadIntent").mockResolvedValue({
      id: "upload-1",
      tokenHash: await sha256Hex(`${secret}\u0000${uploadToken}`),
      filename: "private.txt",
      contentType: "text/plain",
      expectedSize: 7,
      sourceKey: "incoming/upload-1/source.txt",
      status: "uploaded",
      expiresAt: "2026-07-19T00:15:00.000Z",
      actualSize: 7,
      sourceHash: "source-hash",
      aiConsent: accepted,
    });
    const createScan = vi.spyOn(ScanRepository.prototype, "createScan");
    const workflowCreate = vi.fn(async () => undefined);

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/scans", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-upload-token": uploadToken,
        },
        body: JSON.stringify({
          uploadId: "upload-1",
          mode: "quick",
          scanId: "11111111-1111-4111-8111-111111111111",
          scanToken: "A".repeat(43),
        }),
      }),
      env({
        SCAN_ACCEPTING_NEW_JOBS: "true",
        SCAN_AI_PROVIDER: "openrouter",
        OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
        UPLOAD_TOKEN_SECRET: secret,
        SCAN_WORKFLOW: { create: workflowCreate },
      }),
    );

    expect(response.status).toBe(428);
    expect(createScan).not.toHaveBeenCalled();
    expect(workflowCreate).not.toHaveBeenCalled();
  });
});
