import type { ScanHandle } from "./scanApiClient";

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
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(
    handle: Pick<ScanHandle, "scanId" | "scanToken">,
    input: { operation: HostedAiOperation; prompt: string; context?: string },
  ): Promise<{ response: string; costWeight: number }> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/v1/scans/${encodeURIComponent(handle.scanId)}/editor-ai`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-scan-token": handle.scanToken,
        },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok)
      throw new Error(`Hosted AI request failed (${response.status})`);
    return (await response.json()) as { response: string; costWeight: number };
  }
}
