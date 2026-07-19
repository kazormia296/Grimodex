import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import type { ScanEnv } from "./env";
import { ScanRepository } from "./repository";
import { sha256Hex } from "./security";
import {
  createMinimalJaBundle,
  createMinimalJaSeed,
} from "../src/fixtures/minimalJa";
import {
  currentAiDataConsentIdentity,
  expectedAiDataConsentId,
} from "./ai/aiDataDisclosure";
import { parseEditorHandoffEnvelope } from "@grimodex/scan-contract";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

function workersAiEnv(overrides: Partial<ScanEnv> = {}): ScanEnv {
  return env({
    AI: { run: async () => ({ response: "unused" }) },
    SCAN_AI_PROVIDER: "workers-ai",
    SCAN_WORKERS_AI_ENABLED: "true",
    ...overrides,
  });
}

async function workersAiConsent() {
  return currentAiDataConsentIdentity(workersAiEnv(), "scan");
}

describe("scan worker router", () => {
  it("serves a content-free health response and limits CORS to the configured origin", async () => {
    const request = new Request("https://scan.example/api/v1/health", {
      headers: { origin: "https://try.grimodex.app" },
    });
    const response = await handleRequest(request, env());
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://try.grimodex.app",
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      acceptingNewJobs: false,
    });
  });

  it.each(["https://scan.grimodex.app", "https://try.grimodex.app"])(
    "allows configured Scan and Editor origin %s exactly",
    async (origin) => {
      const response = await handleRequest(
        new Request("https://api.grimodex.app/api/v1/health", {
          headers: { origin },
        }),
        env({
          ALLOWED_ORIGINS:
            "https://scan.grimodex.app, https://try.grimodex.app",
        }),
      );

      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("vary")).toBe("Origin");
    },
  );

  it("rejects unlisted and wildcard origins and exposes the scoped session header only to exact origins", async () => {
    const configured = env({
      ALLOWED_ORIGINS: "*,https://scan.grimodex.app,https://try.grimodex.app",
    });
    const hostile = await handleRequest(
      new Request("https://api.grimodex.app/api/v1/health", {
        headers: { origin: "https://attacker.example" },
      }),
      configured,
    );
    const preflight = await handleRequest(
      new Request("https://api.grimodex.app/api/v1/scans/scan-1/editor-ai", {
        method: "OPTIONS",
        headers: { origin: "https://try.grimodex.app" },
      }),
      configured,
    );

    expect(hostile.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://try.grimodex.app",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "x-editor-session-token",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "x-scan-source-language",
    );
  });

  it("stores the validated writing-language choice in source object metadata", async () => {
    const aiConsent = await workersAiConsent();
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
      aiConsent,
    });
    vi.spyOn(ScanRepository.prototype, "markUploadComplete").mockResolvedValue(
      undefined,
    );
    const put = vi.fn(async () => undefined);

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/uploads/upload-1", {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "x-upload-token": "upload-token",
          "x-scan-source-language": "en",
        },
        body: "private",
      }),
      workersAiEnv({
        SCAN_BUCKET: {
          put,
          get: async () => null,
          head: async () => null,
          delete: async () => undefined,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      "incoming/upload-1/source.txt",
      expect.any(Uint8Array),
      {
        httpMetadata: { contentType: "text/plain" },
        customMetadata: expect.objectContaining({
          schemaVersion: "source-text/1",
          sourceLanguage: "en",
        }),
      },
    );
  });

  it("rejects an invalid source-language header before storing manuscript bytes", async () => {
    const aiConsent = await workersAiConsent();
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
      aiConsent,
    });
    vi.spyOn(ScanRepository.prototype, "markUploadComplete").mockResolvedValue(
      undefined,
    );
    vi.spyOn(ScanRepository.prototype, "releaseUploadClaim").mockResolvedValue(
      undefined,
    );
    const put = vi.fn(async () => undefined);

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/uploads/upload-1", {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "x-upload-token": "upload-token",
          "x-scan-source-language": "fr",
        },
        body: "private",
      }),
      workersAiEnv({
        SCAN_BUCKET: {
          put,
          get: async () => null,
          head: async () => null,
          delete: async () => undefined,
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_source_language" },
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("does not issue upload intents while the kill switch is off", async () => {
    const request = new Request("https://scan.example/api/v1/upload-intents", {
      method: "POST",
      body: JSON.stringify({
        filename: "novel.txt",
        contentType: "text/plain",
        size: 5,
      }),
      headers: { "content-type": "application/json" },
    });
    const response = await handleRequest(request, env());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "scan_paused" },
    });
  });

  it("serves published reports without a cache window so unpublish is immediate", async () => {
    const database = {
      prepare: (query: string) => {
        const statement = {
          bind: () => statement,
          first: async <T>() =>
            query.includes("FROM public_reports")
              ? ({
                  id: "public-1",
                  scan_id: "scan-1",
                  artifact_key: "public/scan-1/report.json",
                  status: "published",
                  author_confirmed_at: "2026-07-16T00:00:00.000Z",
                } as T)
              : null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        };
        return statement;
      },
      batch: async () => [],
    };
    const body = JSON.stringify({
      schemaVersion: "grimodex-scan/public-report/1",
    });
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/public-reports/public-1"),
      env({
        DB: database,
        SCAN_BUCKET: {
          put: async () => undefined,
          get: async () => ({
            body: new Response(body).body,
            size: body.length,
            httpMetadata: { contentType: "application/json" },
          }),
          head: async () => null,
          delete: async () => undefined,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["missing", "create-failed"] as const)(
    "settles a created scan exactly once when the workflow binding is %s",
    async (failureMode) => {
      const uploadToken = "upload-token";
      const scanId = "11111111-1111-4111-8111-111111111111";
      const scanToken = "A".repeat(43);
      const secret = "test-secret";
      const aiConsent = await workersAiConsent();
      const scan = {
        id: scanId,
        uploadId: "upload-1",
        mode: "quick" as const,
        status: "failed" as const,
        sourceHash: "source-hash",
        privateBundleKey: null,
        privateReportKey: null,
        cancelRequestedAt: null,
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        accessTokenHash: "scan-token-hash",
        aiConsent,
      };
      vi.spyOn(ScanRepository.prototype, "getUploadIntent").mockResolvedValue({
        id: "upload-1",
        tokenHash: await sha256Hex(`${secret}\u0000${uploadToken}`),
        filename: "novel.txt",
        contentType: "text/plain",
        expectedSize: 12,
        sourceKey: "incoming/upload-1/source.txt",
        status: "uploaded",
        expiresAt: "2026-07-17T00:00:00.000Z",
        actualSize: 12,
        sourceHash: "source-hash",
        aiConsent,
      });
      vi.spyOn(ScanRepository.prototype, "reserveUsage").mockResolvedValue(
        true,
      );
      vi.spyOn(ScanRepository.prototype, "createScan").mockResolvedValue(
        "created",
      );
      vi.spyOn(ScanRepository.prototype, "transitionScan").mockResolvedValue(
        scan,
      );
      const settleUsage = vi
        .spyOn(ScanRepository.prototype, "settleUsage")
        .mockResolvedValue(undefined);
      const rawRelease = vi
        .spyOn(ScanRepository.prototype, "releaseReservedUsageBuckets")
        .mockResolvedValue(undefined);
      const workflowCreate = vi.fn(async () => {
        throw new Error("workflow create response was lost");
      });
      const response = await handleRequest(
        new Request("https://scan.example/api/v1/scans", {
          method: "POST",
          headers: {
            authorization: `Bearer ${uploadToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            uploadId: "upload-1",
            mode: "quick",
            scanId,
            scanToken,
          }),
        }),
        workersAiEnv({
          SCAN_ACCEPTING_NEW_JOBS: "true",
          SCAN_DAILY_LIMIT_UNITS: "100",
          SCAN_MONTHLY_LIMIT_UNITS: "1000",
          UPLOAD_TOKEN_SECRET: secret,
          ...(failureMode === "create-failed"
            ? { SCAN_WORKFLOW: { create: workflowCreate } }
            : {}),
        }),
      );

      expect(response.status).toBe(503);
      expect(settleUsage).toHaveBeenCalledOnce();
      expect(settleUsage).toHaveBeenCalledWith(scanId, 0);
      expect(rawRelease).not.toHaveBeenCalled();
      expect(workflowCreate).toHaveBeenCalledTimes(
        failureMode === "create-failed" ? 1 : 0,
      );
    },
  );

  it.each([
    {
      scanId: "not-a-uuid",
      scanToken: "A".repeat(43),
      code: "invalid_scan_id",
    },
    {
      scanId: "11111111-1111-4111-8111-111111111111",
      scanToken: "too-short",
      code: "invalid_scan_token",
    },
  ])("rejects an invalid client scan handle with $code", async (body) => {
    const getUpload = vi.spyOn(ScanRepository.prototype, "getUploadIntent");
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/scans", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-upload-token": "upload-token",
        },
        body: JSON.stringify({
          uploadId: "upload-1",
          mode: "quick",
          scanId: body.scanId,
          scanToken: body.scanToken,
        }),
      }),
      env({ SCAN_ACCEPTING_NEW_JOBS: "true" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: body.code },
    });
    expect(getUpload).not.toHaveBeenCalled();
  });

  it("keeps an existing queued scan intact when duplicate workflow dispatch is ambiguous", async () => {
    const uploadToken = "upload-token";
    const scanId = "11111111-1111-4111-8111-111111111111";
    const scanToken = "A".repeat(43);
    const secret = "test-secret";
    const aiConsent = await workersAiConsent();
    vi.spyOn(ScanRepository.prototype, "getUploadIntent").mockResolvedValue({
      id: "upload-1",
      tokenHash: await sha256Hex(`${secret}\u0000${uploadToken}`),
      filename: "novel.txt",
      contentType: "text/plain",
      expectedSize: 12,
      sourceKey: "incoming/upload-1/source.txt",
      status: "consumed",
      expiresAt: "2026-07-17T00:00:00.000Z",
      actualSize: 12,
      sourceHash: "source-hash",
      aiConsent,
    });
    const createScan = vi
      .spyOn(ScanRepository.prototype, "createScan")
      .mockResolvedValue("existing");
    vi.spyOn(ScanRepository.prototype, "getScan").mockResolvedValue({
      id: scanId,
      uploadId: "upload-1",
      mode: "quick",
      status: "queued",
      sourceHash: "source-hash",
      privateBundleKey: null,
      privateReportKey: null,
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessTokenHash: await sha256Hex(`${secret}\u0000${scanToken}`),
      aiConsent,
    });
    const transitionScan = vi.spyOn(ScanRepository.prototype, "transitionScan");
    const settleUsage = vi.spyOn(ScanRepository.prototype, "settleUsage");
    const workflowCreate = vi.fn(async () => {
      throw new Error("workflow id may already exist");
    });

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
          scanId,
          scanToken,
        }),
      }),
      workersAiEnv({
        SCAN_ACCEPTING_NEW_JOBS: "true",
        UPLOAD_TOKEN_SECRET: secret,
        SCAN_WORKFLOW: { create: workflowCreate },
      }),
    );

    expect(response.status).toBe(503);
    expect(workflowCreate).toHaveBeenCalledWith({
      id: scanId,
      params: { scanId },
    });
    expect(transitionScan).not.toHaveBeenCalled();
    expect(settleUsage).not.toHaveBeenCalled();
    expect(createScan).toHaveBeenCalledWith(
      expect.objectContaining({
        id: scanId,
        uploadId: "upload-1",
        mode: "quick",
        accessTokenHash: await sha256Hex(`${secret}\u0000${scanToken}`),
      }),
    );
  });

  it("does not redispatch an existing scan that already advanced beyond queued", async () => {
    const uploadToken = "upload-token";
    const scanId = "11111111-1111-4111-8111-111111111111";
    const scanToken = "A".repeat(43);
    const secret = "test-secret";
    const aiConsent = await workersAiConsent();
    vi.spyOn(ScanRepository.prototype, "getUploadIntent").mockResolvedValue({
      id: "upload-1",
      tokenHash: await sha256Hex(`${secret}\u0000${uploadToken}`),
      filename: "novel.txt",
      contentType: "text/plain",
      expectedSize: 12,
      sourceKey: "incoming/upload-1/source.txt",
      status: "consumed",
      expiresAt: "2026-07-17T00:00:00.000Z",
      actualSize: 12,
      sourceHash: "source-hash",
      aiConsent,
    });
    vi.spyOn(ScanRepository.prototype, "createScan").mockResolvedValue(
      "existing",
    );
    vi.spyOn(ScanRepository.prototype, "getScan").mockResolvedValue({
      id: scanId,
      uploadId: "upload-1",
      mode: "quick",
      status: "extracting",
      sourceHash: "source-hash",
      privateBundleKey: null,
      privateReportKey: null,
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:01:00.000Z",
      accessTokenHash: await sha256Hex(`${secret}\u0000${scanToken}`),
      aiConsent,
    });
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
          scanId,
          scanToken,
        }),
      }),
      workersAiEnv({
        SCAN_ACCEPTING_NEW_JOBS: "true",
        UPLOAD_TOKEN_SECRET: secret,
        SCAN_WORKFLOW: { create: workflowCreate },
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      scanId,
      scanToken,
      mode: "quick",
      status: "extracting",
    });
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("returns a conflict without dispatching when a scan id belongs to another request", async () => {
    const uploadToken = "upload-token";
    const scanId = "11111111-1111-4111-8111-111111111111";
    const scanToken = "A".repeat(43);
    const secret = "test-secret";
    const aiConsent = await workersAiConsent();
    vi.spyOn(ScanRepository.prototype, "getUploadIntent").mockResolvedValue({
      id: "upload-1",
      tokenHash: await sha256Hex(`${secret}\u0000${uploadToken}`),
      filename: "novel.txt",
      contentType: "text/plain",
      expectedSize: 12,
      sourceKey: "incoming/upload-1/source.txt",
      status: "uploaded",
      expiresAt: "2026-07-17T00:00:00.000Z",
      actualSize: 12,
      sourceHash: "source-hash",
      aiConsent,
    });
    vi.spyOn(ScanRepository.prototype, "createScan").mockResolvedValue(
      "conflict",
    );
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
          scanId,
          scanToken,
        }),
      }),
      workersAiEnv({
        SCAN_ACCEPTING_NEW_JOBS: "true",
        UPLOAD_TOKEN_SECRET: secret,
        SCAN_WORKFLOW: { create: workflowCreate },
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "scan_id_conflict" },
    });
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("applies the existing rate limiter to finding feedback", async () => {
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/scans/scan-1/feedback", {
        method: "POST",
        headers: {
          authorization: "Bearer scan-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          findingId: "finding:66666666-6666-4666-8666-666666666666",
          status: "intentional",
        }),
      }),
      env({ RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) } }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
  });

  it("rejects feedback for a finding that is not in the authorized scan", async () => {
    const bundle = createMinimalJaBundle();
    vi.spyOn(ScanRepository.prototype, "authorizeScan").mockResolvedValue({
      id: "scan-1",
      uploadId: "upload-1",
      mode: "quick",
      status: "completed",
      sourceHash: "source-hash",
      privateBundleKey: "artifacts/scan-1/bundle.json",
      privateReportKey: "artifacts/scan-1/report.json",
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
    });
    const saveFeedback = vi
      .spyOn(ScanRepository.prototype, "saveFindingFeedback")
      .mockResolvedValue(undefined);
    const serialized = JSON.stringify(bundle);
    const response = await handleRequest(
      new Request("https://scan.example/api/v1/scans/scan-1/feedback", {
        method: "POST",
        headers: {
          authorization: "Bearer scan-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          findingId: "finding:77777777-7777-4777-8777-777777777777",
          status: "intentional",
        }),
      }),
      env({
        SCAN_BUCKET: {
          put: async () => undefined,
          get: async () => ({
            body: new Response(serialized).body,
            size: serialized.length,
            httpMetadata: { contentType: "application/json" },
          }),
          head: async () => null,
          delete: async () => undefined,
        },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "finding_not_found" },
    });
    expect(saveFeedback).not.toHaveBeenCalled();
  });

  it("does not run editor AI when the atomic quota claim fails", async () => {
    vi.spyOn(ScanRepository.prototype, "authorizeScan").mockResolvedValue({
      id: "scan-1",
      uploadId: "upload-1",
      mode: "quick",
      status: "completed",
      sourceHash: "source-hash",
      privateBundleKey: "artifacts/scan-1/bundle.json",
      privateReportKey: "artifacts/scan-1/report.json",
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
    });
    vi.spyOn(ScanRepository.prototype, "getAiUsageOperation").mockResolvedValue(
      null,
    );
    vi.spyOn(
      ScanRepository.prototype,
      "claimAndReserveAiUsage",
    ).mockRejectedValue(new Error("D1 ledger unavailable"));
    const aiRun = vi.fn(async () => ({ response: "must not run" }));
    const testEnv = env({
      SCAN_EDITOR_AI_ENABLED: "true",
      SCAN_DAILY_LIMIT_UNITS: "100",
      SCAN_MONTHLY_LIMIT_UNITS: "1000",
      AI: { run: aiRun },
    });
    const consentId = await expectedAiDataConsentId(testEnv, "hosted-editor");

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/scans/scan-1/editor-ai", {
        method: "POST",
        headers: {
          authorization: "Bearer scan-token",
          "content-type": "application/json",
          "x-idempotency-key": "request-accounting-failure",
          "x-ai-consent-id": consentId,
        },
        body: JSON.stringify({ operation: "chat", prompt: "help" }),
      }),
      testEnv,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "editor_ai_accounting_unavailable" },
    });
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("does not refund a successful editor AI call when final accounting fails", async () => {
    vi.spyOn(ScanRepository.prototype, "authorizeScan").mockResolvedValue({
      id: "scan-1",
      uploadId: "upload-1",
      mode: "quick",
      status: "completed",
      sourceHash: "source-hash",
      privateBundleKey: "artifacts/scan-1/bundle.json",
      privateReportKey: "artifacts/scan-1/report.json",
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
    });
    vi.spyOn(ScanRepository.prototype, "getScan").mockResolvedValue({
      id: "scan-1",
      uploadId: "upload-1",
      mode: "quick",
      status: "completed",
      sourceHash: "source-hash",
      privateBundleKey: "artifacts/scan-1/bundle.json",
      privateReportKey: "artifacts/scan-1/report.json",
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
    });
    vi.spyOn(ScanRepository.prototype, "getAiUsageOperation").mockResolvedValue(
      null,
    );
    vi.spyOn(
      ScanRepository.prototype,
      "claimAndReserveAiUsage",
    ).mockResolvedValue({ claimed: true, operation: null });
    const finalize = vi
      .spyOn(ScanRepository.prototype, "finalizeAiUsageOperation")
      .mockRejectedValue(new Error("D1 completion write failed"));
    const aiRun = vi.fn(async () => ({ response: "gateway-ok" }));
    const testEnv = env({
      SCAN_EDITOR_AI_ENABLED: "true",
      SCAN_DAILY_LIMIT_UNITS: "100",
      SCAN_MONTHLY_LIMIT_UNITS: "1000",
      AI: { run: aiRun },
    });
    const consentId = await expectedAiDataConsentId(testEnv, "hosted-editor");

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/scans/scan-1/editor-ai", {
        method: "POST",
        headers: {
          authorization: "Bearer scan-token",
          "content-type": "application/json",
          "x-idempotency-key": "request-completion-failure",
          "x-ai-consent-id": consentId,
        },
        body: JSON.stringify({ operation: "chat", prompt: "help" }),
      }),
      testEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "gateway-ok",
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(aiRun).toHaveBeenCalledOnce();
  });

  it("reuses a persisted editor AI result for the same idempotency key", async () => {
    vi.spyOn(ScanRepository.prototype, "authorizeScan").mockResolvedValue({
      id: "scan-1",
      uploadId: "upload-1",
      mode: "quick",
      status: "completed",
      sourceHash: "source-hash",
      privateBundleKey: "artifacts/scan-1/bundle.json",
      privateReportKey: "artifacts/scan-1/report.json",
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
    });
    vi.spyOn(ScanRepository.prototype, "getScan").mockResolvedValue({
      id: "scan-1",
      uploadId: "upload-1",
      mode: "quick",
      status: "completed",
      sourceHash: "source-hash",
      privateBundleKey: "artifacts/scan-1/bundle.json",
      privateReportKey: "artifacts/scan-1/report.json",
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
    });
    vi.spyOn(ScanRepository.prototype, "getAiUsageOperation").mockResolvedValue(
      null,
    );
    const claim = vi
      .spyOn(ScanRepository.prototype, "claimAndReserveAiUsage")
      .mockResolvedValue({ claimed: true, operation: null });
    const finalize = vi
      .spyOn(ScanRepository.prototype, "finalizeAiUsageOperation")
      .mockResolvedValue(undefined);
    const aiRun = vi.fn(async () => ({
      response: "設定を確認します",
      tool_calls: [{ name: "search_codex", arguments: { query: "星の設定" } }],
    }));
    const objects = new Map<string, string>();
    const testEnv = env({
      SCAN_EDITOR_AI_ENABLED: "true",
      SCAN_DAILY_LIMIT_UNITS: "100",
      SCAN_MONTHLY_LIMIT_UNITS: "1000",
      AI: { run: aiRun },
      SCAN_BUCKET: {
        put: async (key, value) => {
          objects.set(key, String(value));
        },
        get: async (key) => {
          const value = objects.get(key);
          return value === undefined
            ? null
            : {
                body: new Response(value).body,
                size: value.length,
                httpMetadata: { contentType: "application/json" },
              };
        },
        head: async () => null,
        delete: async () => undefined,
      },
    });
    const consentId = await expectedAiDataConsentId(testEnv, "hosted-editor");
    const request = () =>
      new Request("https://scan.example/api/v1/scans/scan-1/editor-ai", {
        method: "POST",
        headers: {
          authorization: "Bearer scan-token",
          "content-type": "application/json",
          "x-idempotency-key": "request-retry-123456",
          "x-ai-consent-id": consentId,
        },
        body: JSON.stringify({
          operation: "codex",
          prompt: "help",
          messages: [{ role: "user", content: "help" }],
          tools: [
            {
              name: "search_codex",
              description: "Search",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        }),
      });

    const first = await handleRequest(request(), testEnv);
    const second = await handleRequest(request(), testEnv);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      response: "設定を確認します",
      costWeight: 3,
      toolCalls: [
        {
          name: "search_codex",
          input: { query: "星の設定" },
        },
      ],
    });
    for (const [key, serialized] of objects) {
      const artifact = JSON.parse(serialized) as {
        status?: string;
        toolCalls?: Array<{ name: string }>;
      };
      if (artifact.status === "completed" && artifact.toolCalls?.[0]) {
        artifact.toolCalls[0].name = "delete_workspace";
        objects.set(key, JSON.stringify(artifact));
      }
    }
    const corruptedReplay = await handleRequest(request(), testEnv);

    expect(corruptedReplay.status).toBe(500);
    await expect(corruptedReplay.json()).resolves.toMatchObject({
      error: { code: "editor_ai_result_invalid" },
    });
    expect(aiRun).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it("keeps a publication registry row when an ambiguous R2 put cannot be cleaned up", async () => {
    const bundle = createMinimalJaBundle();
    const completedScan = {
      id: "scan-1",
      uploadId: "upload-1",
      mode: "quick" as const,
      status: "completed" as const,
      sourceHash: "source-hash",
      privateBundleKey: "artifacts/scan-1/bundle.json",
      privateReportKey: "artifacts/scan-1/report.json",
      cancelRequestedAt: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessTokenHash: "scan-token-hash",
    };
    vi.spyOn(ScanRepository.prototype, "authorizeScan").mockResolvedValue(
      completedScan,
    );
    vi.spyOn(ScanRepository.prototype, "getFindingFeedback").mockResolvedValue(
      new Map(),
    );
    vi.spyOn(
      ScanRepository.prototype,
      "getPublicReportByScanId",
    ).mockResolvedValue(null);
    vi.spyOn(
      ScanRepository.prototype,
      "registerPublicReportArtifact",
    ).mockResolvedValue(true);
    const forget = vi
      .spyOn(ScanRepository.prototype, "forgetPublicReportArtifact")
      .mockResolvedValue(undefined);
    const remove = vi.fn(async () => {
      throw new Error("R2 delete unavailable");
    });
    const serialized = JSON.stringify(bundle);

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/scans/scan-1/public-report", {
        method: "POST",
        headers: {
          authorization: "Bearer scan-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          authorConfirmedAt: "2026-07-16T00:00:00.000Z",
        }),
      }),
      env({
        SCAN_BUCKET: {
          put: async () => {
            // R2 may commit the object and still lose the HTTP response.
            throw new Error("R2 put response lost");
          },
          get: async () => ({
            body: new Response(serialized).body,
            size: serialized.length,
            httpMetadata: { contentType: "application/json" },
          }),
          head: async () => null,
          delete: remove,
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(remove).toHaveBeenCalledOnce();
    expect(forget).not.toHaveBeenCalled();
  });

  it("exchanges a one-time seed token for a validated seed and a 24-hour scoped Editor session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    const scanId = "11111111-1111-4111-8111-111111111111";
    const oneTimeRecord = {
      scanId,
      artifactKey: `artifacts/${scanId}/editor-seed.json`,
      expiresAt: "2026-07-19T00:10:00.000Z",
    };
    vi.spyOn(ScanRepository.prototype, "getEditorToken").mockResolvedValue(
      oneTimeRecord,
    );
    vi.spyOn(ScanRepository.prototype, "consumeEditorToken").mockResolvedValue(
      oneTimeRecord,
    );
    const createSession = vi
      .spyOn(ScanRepository.prototype, "createEditorSession")
      .mockResolvedValue(undefined);
    const seed = createMinimalJaSeed();
    const serialized = JSON.stringify(seed);
    const testEnv = env({
      UPLOAD_TOKEN_SECRET: "worker-secret",
      SCAN_BUCKET: {
        put: async () => undefined,
        get: async () => ({
          body: new Response(serialized).body,
          size: serialized.length,
          httpMetadata: { contentType: "application/json" },
        }),
        head: async () => null,
        delete: async () => undefined,
      },
    });

    const response = await handleRequest(
      new Request("https://scan.example/api/v1/editor-seeds", {
        headers: { authorization: "Bearer one-time-token" },
      }),
      testEnv,
    );
    const body = (await response.json()) as Record<string, unknown>;
    const parsed = parseEditorHandoffEnvelope(body);

    expect(response.status).toBe(200);
    expect(parsed.ok).toBe(true);
    expect(body).toMatchObject({
      schemaVersion: "grimodex/editor-handoff/1",
      seed,
      hostedAiSession: {
        scanId,
        expiresAt: "2026-07-20T00:00:00.000Z",
      },
    });
    const rawSessionToken = (body.hostedAiSession as { token: string }).token;
    expect(rawSessionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(createSession).toHaveBeenCalledWith({
      scanId,
      tokenHash: await sha256Hex(`worker-secret\u0000${rawSessionToken}`),
      expiresAt: "2026-07-20T00:00:00.000Z",
    });
    expect(createSession.mock.calls[0]?.[0].tokenHash).not.toBe(
      rawSessionToken,
    );
  });

  it("uses an active scoped Editor session for hosted AI without exposing scan mutation authority", async () => {
    const scanId = "11111111-1111-4111-8111-111111111111";
    const completedScan = {
      id: scanId,
      uploadId: "upload-1",
      mode: "quick" as const,
      status: "completed" as const,
      sourceHash: "source-hash",
      privateBundleKey: `artifacts/${scanId}/bundle.json`,
      privateReportKey: `artifacts/${scanId}/report.json`,
      cancelRequestedAt: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:10:00.000Z",
      accessTokenHash: "scan-token-hash",
    };
    const authorizeEditor = vi
      .spyOn(ScanRepository.prototype, "authorizeEditorSession")
      .mockResolvedValue(completedScan);
    const authorizeScan = vi.spyOn(ScanRepository.prototype, "authorizeScan");
    vi.spyOn(ScanRepository.prototype, "getScan").mockResolvedValue(
      completedScan,
    );
    vi.spyOn(ScanRepository.prototype, "getAiUsageOperation").mockResolvedValue(
      null,
    );
    vi.spyOn(
      ScanRepository.prototype,
      "claimAndReserveAiUsage",
    ).mockResolvedValue({ claimed: true, operation: null });
    vi.spyOn(
      ScanRepository.prototype,
      "finalizeAiUsageOperation",
    ).mockResolvedValue(undefined);
    const aiRun = vi.fn(async () => ({ response: "scoped response" }));
    const testEnv = env({
      UPLOAD_TOKEN_SECRET: "worker-secret",
      SCAN_EDITOR_AI_ENABLED: "true",
      SCAN_DAILY_LIMIT_UNITS: "100",
      SCAN_MONTHLY_LIMIT_UNITS: "1000",
      AI: { run: aiRun },
    });
    const consentId = await expectedAiDataConsentId(testEnv, "hosted-editor");

    const response = await handleRequest(
      new Request(`https://scan.example/api/v1/scans/${scanId}/editor-ai`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-editor-session-token": "scoped-token",
          "x-idempotency-key": "scoped-request-123456",
          "x-ai-consent-id": consentId,
        },
        body: JSON.stringify({ operation: "chat", prompt: "help" }),
      }),
      testEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "scoped response",
    });
    expect(authorizeEditor).toHaveBeenCalledWith(
      scanId,
      await sha256Hex("worker-secret\u0000scoped-token"),
    );
    expect(authorizeScan).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledOnce();
  });

  it.each(["expired", "revoked", "different-scan"])(
    "rejects a %s scoped Editor session before hosted AI runs",
    async () => {
      vi.spyOn(
        ScanRepository.prototype,
        "authorizeEditorSession",
      ).mockResolvedValue(null);
      const aiRun = vi.fn(async () => ({ response: "must not run" }));
      const testEnv = env({
        SCAN_EDITOR_AI_ENABLED: "true",
        AI: { run: aiRun },
      });
      const response = await handleRequest(
        new Request("https://scan.example/api/v1/scans/scan-1/editor-ai", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-editor-session-token": "invalid-session",
            "x-idempotency-key": "invalid-scoped-request",
            "x-ai-consent-id": "irrelevant-before-auth",
          },
          body: JSON.stringify({ operation: "chat", prompt: "help" }),
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "scan_not_found" },
      });
      expect(aiRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "scan deletion",
      method: "DELETE",
      path: "/api/v1/scans/scan-1",
      body: undefined,
    },
    {
      label: "public report publication",
      method: "POST",
      path: "/api/v1/scans/scan-1/public-report",
      body: JSON.stringify({
        authorConfirmedAt: "2026-07-19T00:00:00.000Z",
      }),
    },
  ])("does not accept a scoped Editor session for $label", async (variant) => {
    const authorizeEditor = vi.spyOn(
      ScanRepository.prototype,
      "authorizeEditorSession",
    );
    const response = await handleRequest(
      new Request(`https://scan.example${variant.path}`, {
        method: variant.method,
        headers: {
          "content-type": "application/json",
          "x-editor-session-token": "scoped-token",
        },
        body: variant.body,
      }),
      env(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "scan_token_required" },
    });
    expect(authorizeEditor).not.toHaveBeenCalled();
  });

  it("rejects cross-origin simple requests before recording public abuse", async () => {
    const response = await handleRequest(
      new Request(
        "https://scan.example/api/v1/public-reports/public-1/abuse-reports",
        {
          method: "POST",
          headers: {
            origin: "https://attacker.example",
            "content-type": "text/plain;charset=UTF-8",
          },
          body: JSON.stringify({ reason: "automated cross-site report" }),
        },
      ),
      env(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "origin_not_allowed" },
    });
  });
});
