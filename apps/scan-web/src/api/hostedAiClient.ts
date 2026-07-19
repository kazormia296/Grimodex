import type { ScanHandle } from "./scanApiClient";
import {
  CLOUD_CONTENT_POLICY_ACK_HEADER,
  CLOUD_CONTENT_POLICY_VERSION,
} from "@grimodex/scan-contract";

export type HostedAiOperation = "chat" | "inline" | "codex";

export const HOSTED_AI_COST_WEIGHT: Record<HostedAiOperation, number> = {
  chat: 1,
  inline: 2,
  codex: 3,
};

export interface HostedAiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class HostedAiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HostedAiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async complete(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
    input: {
      operation: HostedAiOperation;
      prompt: string;
      context?: string;
      /** Reuse this value when retrying a request whose response was lost. */
      idempotencyKey: string;
      /** Opaque identity returned by the current hosted-editor disclosure. */
      consentId: string;
    },
  ): Promise<{ response: string; costWeight: number }> {
    const { idempotencyKey, consentId, ...body } = input;
    const normalizedConsentId = consentId?.trim() ?? "";
    if (!/^consent_[A-Za-z0-9_-]{16,248}$/.test(normalizedConsentId)) {
      throw new Error("AI data consent is required");
    }
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/v1/scans/${encodeURIComponent(handle.scanId)}/editor-ai`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-scan-token": handle.scanToken,
          "x-idempotency-key": idempotencyKey,
          "x-ai-consent-id": normalizedConsentId,
          [CLOUD_CONTENT_POLICY_ACK_HEADER]: CLOUD_CONTENT_POLICY_VERSION,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(`Hosted AI request failed (${response.status})`);
    return (await response.json()) as { response: string; costWeight: number };
  }
}
