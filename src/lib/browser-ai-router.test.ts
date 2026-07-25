import { describe, expect, it, vi } from "vitest";
import {
  createBrowserAiRouterTransport,
  type BrowserAiRouterTransportOptions,
} from "./browser-ai-router";
import type { BrowserAiRequest } from "./browser-ai";

function request(browserAiMode: "http" | "webgpu"): BrowserAiRequest {
  return {
    operation: "chat",
    provider: "ollama",
    model: "local-model",
    messages: [{ role: "user", content: "hello" }],
    browserAiMode,
  };
}

describe("BrowserAiRouterTransport", () => {
  it("routes HTTP and WebGPU requests to their dedicated transports", async () => {
    const httpCompletion = {
      blocks: [{ type: "text" as const, content: "http" }],
      stopReason: "end_turn" as const,
    };
    const webGpuCompletion = {
      blocks: [{ type: "text" as const, content: "webgpu" }],
      stopReason: "end_turn" as const,
    };
    const options: BrowserAiRouterTransportOptions = {
      httpTransport: { complete: vi.fn(async () => httpCompletion) },
      webGpuTransport: { complete: vi.fn(async () => webGpuCompletion) },
    };
    const router = createBrowserAiRouterTransport(options);

    await expect(router.complete(request("http"))).resolves.toEqual(
      httpCompletion,
    );
    await expect(router.complete(request("webgpu"))).resolves.toEqual(
      webGpuCompletion,
    );
    expect(options.httpTransport.complete).toHaveBeenCalledOnce();
    expect(options.webGpuTransport.complete).toHaveBeenCalledOnce();
  });

  it("fails closed for Agent tool use in the WebGPU mode", async () => {
    const router = createBrowserAiRouterTransport({
      httpTransport: { complete: vi.fn() },
      webGpuTransport: { complete: vi.fn(async () => ({
        blocks: [],
        stopReason: "end_turn" as const,
      })) },
    });

    await expect(
      router.completeAgent?.(request("webgpu"), [], []),
    ).rejects.toThrow(/WebGPU.*Agent|Agent.*WebGPU/i);
  });
});
