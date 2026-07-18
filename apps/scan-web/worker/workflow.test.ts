import { describe, expect, it, vi } from "vitest";
import type { ScanEnv } from "./env";
import type { ScanRepository, ScanSessionRecord } from "./repository";
import {
  currentAiDataConsentIdentity,
  type AiDataConsentIdentity,
} from "./ai/aiDataDisclosure";
import { ensureWorkflowScanActive } from "./workflowConsent";
import { isCancellationRequestedOrTerminal } from "./workflowState";

function consentEnv(overrides: Partial<ScanEnv> = {}): ScanEnv {
  return {
    DB: {
      prepare: () => {
        throw new Error("D1 should not be used directly");
      },
      batch: async () => [],
    },
    SCAN_BUCKET: {
      put: async () => undefined,
      get: async () => null,
      head: async () => null,
      delete: async () => undefined,
    },
    AI: { run: vi.fn(async () => ({ response: "unused" })) },
    SCAN_AI_PROVIDER: "workers-ai",
    ...overrides,
  };
}

function activeScan(
  aiConsent: AiDataConsentIdentity | null,
): ScanSessionRecord {
  return {
    id: "scan-1",
    uploadId: "upload-1",
    mode: "quick",
    status: "extracting",
    sourceHash: "source-hash",
    privateBundleKey: null,
    privateReportKey: null,
    cancelRequestedAt: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    accessTokenHash: "token-hash",
    aiConsent,
  };
}

describe("scan workflow failure classification", () => {
  it.each(["cancel_requested", "cancelled", "deleted"] as const)(
    "preserves %s when a concurrent step fails",
    (status) => {
      expect(isCancellationRequestedOrTerminal(status)).toBe(true);
    },
  );

  it("still classifies ordinary active failures as failed", () => {
    expect(isCancellationRequestedOrTerminal("extracting")).toBe(false);
  });

  it("fails an active workflow retry when provider configuration changed", async () => {
    const acceptedEnv = consentEnv();
    const accepted = await currentAiDataConsentIdentity(acceptedEnv, "scan");
    const repository = {
      getScan: vi.fn(async () => activeScan(accepted)),
    } as unknown as ScanRepository;
    const changedEnv = consentEnv({
      AI: undefined,
      SCAN_AI_PROVIDER: "openrouter",
      OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
    });

    await expect(
      ensureWorkflowScanActive(repository, "scan-1", changedEnv),
    ).rejects.toThrow(/AI data consent/i);
  });

  it("fails closed for a legacy workflow session without consent identity", async () => {
    const repository = {
      getScan: vi.fn(async () => activeScan(null)),
    } as unknown as ScanRepository;

    await expect(
      ensureWorkflowScanActive(repository, "scan-1", consentEnv()),
    ).rejects.toThrow(/AI data consent/i);
  });
});
