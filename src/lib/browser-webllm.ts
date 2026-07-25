import type { AiModel, BrowserAiMode } from "@/features/chat/types";
import {
  BrowserAiConnectionError,
  type BrowserAiRequest,
  type BrowserAiStreamSink,
  type BrowserAiTransport,
} from "./browser-ai";

export interface WebLlmCompletionChunkLike {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
    };
    finish_reason?: unknown;
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

export interface WebLlmEngineLike {
  chat: {
    completions: {
      create(request: Record<string, unknown>): Promise<unknown>;
    };
  };
  interruptGenerate?: () => void;
  unload?: () => Promise<void>;
}

export interface WebLlmModelRecordLike {
  model_id?: unknown;
  low_resource?: unknown;
}

export interface WebLlmModuleLike {
  prebuiltAppConfig?: { model_list?: unknown };
  CreateWebWorkerMLCEngine(
    worker: Worker,
    model: string,
    config?: Record<string, unknown>,
  ): Promise<WebLlmEngineLike>;
}

export interface WebGpuBrowserAiTransportOptions {
  loadModule?: () => Promise<WebLlmModuleLike>;
  createWorker?: () => Worker;
  hasWebGpu?: () => boolean;
}

const PREFERRED_WEBGPU_MODEL_IDS = [
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
  "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
  "gemma-2-2b-jpn-it-q4f16_1-MLC",
] as const;

function hasBrowserWebGpu(): boolean {
  if (typeof navigator === "undefined") return false;
  return Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

async function loadWebLlmModule(): Promise<WebLlmModuleLike> {
  const module = await import("@mlc-ai/web-llm");
  return module as unknown as WebLlmModuleLike;
}

function createWebLlmWorker(): Worker {
  return new Worker(new URL("../workers/webllm.worker.ts", import.meta.url), {
    type: "module",
  });
}

function webGpuError(
  message: string,
  cause?: unknown,
): BrowserAiConnectionError {
  return new BrowserAiConnectionError("webgpu-unsupported", message, {
    url: "browser://webgpu",
    cause,
  });
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeStopReason(
  value: unknown,
): "end_turn" | "max_tokens" | "tool_use" {
  if (value === "length" || value === "max_tokens") return "max_tokens";
  if (value === "tool_calls" || value === "tool_use") return "tool_use";
  return "end_turn";
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

function modelListFromModule(module: WebLlmModuleLike): AiModel[] {
  const source = Array.isArray(module.prebuiltAppConfig?.model_list)
    ? (module.prebuiltAppConfig?.model_list as WebLlmModelRecordLike[])
    : [];
  const records = new Map(
    source
      .filter(
        (record): record is WebLlmModelRecordLike & { model_id: string } =>
          typeof record?.model_id === "string",
      )
      .map((record) => [record.model_id, record]),
  );
  return PREFERRED_WEBGPU_MODEL_IDS.filter((id) => records.has(id)).map(
    (id) => ({
      id,
      name: id,
    }),
  );
}

function requestMessages(request: BrowserAiRequest): Array<{
  role: string;
  content: string;
}> {
  return request.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function requestBody(
  request: BrowserAiRequest,
  stream: boolean,
): Record<string, unknown> {
  return {
    messages: requestMessages(request),
    max_tokens: request.maxOutputTokens ?? 4096,
    stream,
  };
}

function assertWebGpuAvailable(hasWebGpu: () => boolean): void {
  if (hasWebGpu()) return;
  throw webGpuError(
    "このブラウザーではWebGPUを利用できません。対応ブラウザーまたはHTTPローカルAIを使用してください。",
  );
}

export function createWebGpuBrowserAiTransport(
  options: WebGpuBrowserAiTransportOptions = {},
): BrowserAiTransport & {
  listModels(request: BrowserAiRequest): Promise<AiModel[]>;
} {
  const loadModule = options.loadModule ?? loadWebLlmModule;
  const createWorker = options.createWorker ?? createWebLlmWorker;
  const hasWebGpu = options.hasWebGpu ?? hasBrowserWebGpu;
  let modulePromise: Promise<WebLlmModuleLike> | null = null;
  let engine: WebLlmEngineLike | null = null;
  let loadedModel = "";
  let worker: Worker | null = null;
  let loadingModel = "";
  let loading: Promise<WebLlmEngineLike> | null = null;
  let aborted = false;
  let activeEngine: WebLlmEngineLike | null = null;

  const getModule = (): Promise<WebLlmModuleLike> => {
    modulePromise ??= loadModule();
    return modulePromise;
  };

  const releaseCurrentEngine = async (): Promise<void> => {
    const current = engine;
    engine = null;
    loadedModel = "";
    if (current?.unload) {
      await current.unload().catch(() => undefined);
    }
    worker?.terminate();
    worker = null;
  };

  const ensureEngine = async (model: string): Promise<WebLlmEngineLike> => {
    assertWebGpuAvailable(hasWebGpu);
    if (engine && loadedModel === model) return engine;
    if (loading && loadingModel === model) return loading;

    await releaseCurrentEngine();
    loadingModel = model;
    const nextWorker = createWorker();
    worker = nextWorker;
    const nextLoading = getModule()
      .then((module) =>
        module.CreateWebWorkerMLCEngine(nextWorker, model, {
          initProgressCallback: () => undefined,
        }),
      )
      .then((nextEngine) => {
        engine = nextEngine;
        loadedModel = model;
        return nextEngine;
      })
      .catch((error) => {
        nextWorker.terminate();
        if (worker === nextWorker) worker = null;
        throw webGpuError(
          "ブラウザー内AIモデルの読み込みに失敗しました。端末のメモリまたはGPU対応状況を確認してください。",
          error,
        );
      })
      .finally(() => {
        if (loading === nextLoading) {
          loading = null;
          loadingModel = "";
        }
      });
    loading = nextLoading;
    return nextLoading;
  };

  const complete = async (request: BrowserAiRequest) => {
    const current = await ensureEngine(request.model);
    activeEngine = current;
    aborted = false;
    try {
      const response = await current.chat.completions.create(
        requestBody(request, false),
      );
      if (aborted) {
        return { blocks: [], stopReason: "end_turn" as const };
      }
      const result = response as {
        choices?: Array<{
          message?: { content?: unknown };
          finish_reason?: unknown;
        }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const choice = result.choices?.[0];
      const content = textFromContent(choice?.message?.content);
      return {
        blocks: content ? [{ type: "text" as const, content }] : [],
        stopReason: normalizeStopReason(choice?.finish_reason),
        inputTokens: finiteNonNegativeNumber(result.usage?.prompt_tokens),
        outputTokens: finiteNonNegativeNumber(result.usage?.completion_tokens),
      };
    } finally {
      if (activeEngine === current) activeEngine = null;
    }
  };

  const stream = async (
    request: BrowserAiRequest,
    sink: BrowserAiStreamSink,
  ): Promise<void> => {
    const current = await ensureEngine(request.model);
    activeEngine = current;
    aborted = false;
    let stopReason: "end_turn" | "max_tokens" | "tool_use" | "stopped" =
      "end_turn";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      sink.done({ stopReason, inputTokens, outputTokens });
    };
    try {
      const response = await current.chat.completions.create(
        requestBody(request, true),
      );
      if (!isAsyncIterable(response)) {
        throw new Error("WebLLM returned a non-streaming response");
      }
      for await (const rawChunk of response) {
        if (aborted) {
          stopReason = "stopped";
          finish();
          return;
        }
        const chunk = rawChunk as WebLlmCompletionChunkLike;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const text = textFromContent(delta?.content);
        if (text) sink.text(text, "text");
        const thinking = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof thinking === "string" && thinking) {
          sink.text(thinking, "thinking");
        }
        if (choice?.finish_reason != null) {
          stopReason = normalizeStopReason(choice.finish_reason);
        }
        inputTokens =
          finiteNonNegativeNumber(chunk.usage?.prompt_tokens) ?? inputTokens;
        outputTokens =
          finiteNonNegativeNumber(chunk.usage?.completion_tokens) ??
          outputTokens;
      }
      finish();
    } catch (error) {
      if (aborted) {
        stopReason = "stopped";
        finish();
        return;
      }
      throw error;
    } finally {
      if (activeEngine === current) activeEngine = null;
    }
  };

  return {
    complete,
    stream,
    listModels: async () => {
      assertWebGpuAvailable(hasWebGpu);
      return modelListFromModule(await getModule());
    },
    abort: () => {
      aborted = true;
      activeEngine?.interruptGenerate?.();
    },
    dispose: () => {
      aborted = true;
      activeEngine?.interruptGenerate?.();
      const current = engine;
      engine = null;
      loadedModel = "";
      worker?.terminate();
      worker = null;
      if (current?.unload) void current.unload().catch(() => undefined);
    },
  };
}

export function isBrowserWebGpuAvailable(): boolean {
  return hasBrowserWebGpu();
}

export function isBrowserAiMode(value: unknown): value is BrowserAiMode {
  return value === "http" || value === "webgpu";
}
