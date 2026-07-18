import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanEnv } from "./env";
import { ScanRepository } from "./repository";
import { handleRequest } from "./router";

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

  it("does not invent disclosures for unknown processing routes", async () => {
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/ai-disclosures/desktop"),
      env({
        AI: { run: vi.fn(async () => ({ response: "unused" })) },
        SCAN_AI_PROVIDER: "workers-ai",
      }),
    );

    expect(response.status).toBe(404);
  });
});

describe("AI data consent enforcement", () => {
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
});
