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
    expect(engine.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
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

  it("keeps a stream aborted while its initial model is still loading", async () => {
    let resolveEngine!: (engine: WebLlmEngineLike) => void;
    const create = vi.fn(async () =>
      (async function* () {
        yield { choices: [{ delta: { content: "must not start" } }] };
      })(),
    );
    const engine: WebLlmEngineLike = {
      chat: { completions: { create } },
    };
    const module: WebLlmModuleLike = {
      prebuiltAppConfig: { model_list: [] },
      CreateWebWorkerMLCEngine: vi.fn(
        () =>
          new Promise<WebLlmEngineLike>((resolve) => {
            resolveEngine = resolve;
          }),
      ),
    };
    const transport = createWebGpuBrowserAiTransport({
      hasWebGpu: () => true,
      loadModule: async () => module,
      createWorker: () => ({ terminate: vi.fn() }) as unknown as Worker,
    });
    const done: unknown[] = [];

    const running = transport.stream?.(request(), {
      text: vi.fn(),
      done: (payload) => done.push(payload),
    });
    await vi.waitFor(() =>
      expect(module.CreateWebWorkerMLCEngine).toHaveBeenCalledOnce(),
    );
    transport.abort?.("chat");
    resolveEngine(engine);
    await running;

    expect(create).not.toHaveBeenCalled();
    expect(done).toEqual([{ stopReason: "stopped" }]);
  });

  it("does not interrupt chat when only inline generation is aborted", async () => {
    let release!: () => void;
    const interruptGenerate = vi.fn();
    const create = vi.fn(async () =>
      (async function* () {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { choices: [{ delta: { content: "chat" } }] };
      })(),
    );
    const engine: WebLlmEngineLike = {
      chat: { completions: { create } },
      interruptGenerate,
    };
    const transport = createWebGpuBrowserAiTransport({
      hasWebGpu: () => true,
      loadModule: async () => fakeModule(engine),
      createWorker: () => ({ terminate: vi.fn() }) as unknown as Worker,
    });

    const running = transport.stream?.(request(), {
      text: vi.fn(),
      done: vi.fn(),
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    transport.abort?.("inline");
    expect(interruptGenerate).not.toHaveBeenCalled();
    release();
    await running;
  });

  it("reports stopped when interruption ends a stream without another chunk", async () => {
    let release!: () => void;
    const interruptGenerate = vi.fn(() => release());
    const create = vi.fn(async () =>
      (async function* () {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield* [];
      })(),
    );
    const engine: WebLlmEngineLike = {
      chat: { completions: { create } },
      interruptGenerate,
    };
    const transport = createWebGpuBrowserAiTransport({
      hasWebGpu: () => true,
      loadModule: async () => fakeModule(engine),
      createWorker: () => ({ terminate: vi.fn() }) as unknown as Worker,
    });
    const done = vi.fn();

    const running = transport.stream?.(request(), {
      text: vi.fn(),
      done,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    transport.abort?.("chat");
    await running;

    expect(interruptGenerate).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ stopReason: "stopped" });
  });

  it("does not retain an engine that finishes loading after disposal", async () => {
    let resolveEngine!: (engine: WebLlmEngineLike) => void;
    const unload = vi.fn(async () => undefined);
    const create = vi.fn();
    const engine: WebLlmEngineLike = {
      chat: { completions: { create } },
      unload,
    };
    const module: WebLlmModuleLike = {
      prebuiltAppConfig: { model_list: [] },
      CreateWebWorkerMLCEngine: vi.fn(
        () =>
          new Promise<WebLlmEngineLike>((resolve) => {
            resolveEngine = resolve;
          }),
      ),
    };
    const terminate = vi.fn();
    const transport = createWebGpuBrowserAiTransport({
      hasWebGpu: () => true,
      loadModule: async () => module,
      createWorker: () => ({ terminate }) as unknown as Worker,
    });

    const running = transport.complete(request());
    await vi.waitFor(() =>
      expect(module.CreateWebWorkerMLCEngine).toHaveBeenCalledOnce(),
    );
    transport.dispose?.();
    resolveEngine(engine);
    await running;

    expect(terminate).toHaveBeenCalled();
    expect(unload).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    await expect(transport.complete(request())).rejects.toMatchObject({
      code: "webgpu-unsupported",
    });
  });
});
