import { describe, expect, it, vi } from "vitest";
import {
  createWebGpuBrowserAiTransport,
  type WebLlmEngineLike,
  type WebLlmModuleLike,
} from "./browser-webllm";
import type { BrowserAiRequest } from "./browser-ai";

function request(): BrowserAiRequest {
  return {
    operation: "chat",
    provider: "ollama",
    model: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    messages: [{ role: "user", content: "hello" }],
    browserAiMode: "webgpu",
  };
}

function fakeModule(engine: WebLlmEngineLike): WebLlmModuleLike {
  return {
    prebuiltAppConfig: {
      model_list: [
        {
          model_id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
          low_resource: true,
        },
      ],
    },
    CreateWebWorkerMLCEngine: vi.fn(async () => engine),
  };
}

describe("WebGpuBrowserAiTransport", () => {
  it("loads a model lazily and normalizes a completion", async () => {
    const engine: WebLlmEngineLike = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [
              {
                message: { content: "local response" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          })),
        },
      },
    };
    const transport = createWebGpuBrowserAiTransport({
      hasWebGpu: () => true,
      loadModule: async () => fakeModule(engine),
      createWorker: () => ({ terminate: vi.fn() }) as unknown as Worker,
    });

    await expect(transport.complete(request())).resolves.toEqual({
      blocks: [{ type: "text", content: "local response" }],
      stopReason: "end_turn",
      inputTokens: 4,
      outputTokens: 2,
    });
    expect(engine.chat.completions.create).toHaveBeenCalledOnce();
  });

  it("streams text and exposes the curated local model list", async () => {
    const engine: WebLlmEngineLike = {
      chat: {
        completions: {
          create: vi.fn(async () =>
            (async function* () {
              yield { choices: [{ delta: { content: "lo" } }] };
              yield {
                choices: [{ delta: { content: "cal" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 3, completion_tokens: 2 },
              };
            })(),
          ),
        },
      },
    };
    const transport = createWebGpuBrowserAiTransport({
      hasWebGpu: () => true,
      loadModule: async () => fakeModule(engine),
      createWorker: () => ({ terminate: vi.fn() }) as unknown as Worker,
    });
    const text: string[] = [];
    const done: unknown[] = [];

    await transport.stream?.(request(), {
      text: (delta) => text.push(delta),
      done: (payload) => done.push(payload),
    });

    expect(text).toEqual(["lo", "cal"]);
    expect(done).toEqual([
      { stopReason: "end_turn", inputTokens: 3, outputTokens: 2 },
    ]);
    await expect(transport.listModels?.(request())).resolves.toEqual([
      {
        id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
        name: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
      },
    ]);
  });

  it("fails with a clear capability error when WebGPU is unavailable", async () => {
    const transport = createWebGpuBrowserAiTransport({
      hasWebGpu: () => false,
      loadModule: vi.fn(),
      createWorker: vi.fn(),
    });

    await expect(transport.complete(request())).rejects.toMatchObject({
      code: "webgpu-unsupported",
    });
  });
});
