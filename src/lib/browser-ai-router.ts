import {
  createBrowserAiTransport,
  fetchModels,
  sendChatWithTools,
  type BrowserAiRequest,
  type BrowserAiStreamSink,
  type BrowserAiTransport,
} from "./browser-ai";
import { createWebGpuBrowserAiTransport } from "./browser-webllm";
import type { AiModel } from "@/features/chat/types";

export interface BrowserAiRouterTransportOptions {
  httpTransport?: BrowserAiTransport;
  webGpuTransport?: BrowserAiTransport;
}

function isWebGpuRequest(request: BrowserAiRequest): boolean {
  return request.browserAiMode === "webgpu";
}

function httpOptions(request: BrowserAiRequest) {
  return {
    ollamaEndpoint: request.ollamaEndpoint,
    baseUrl: request.baseUrl,
    apiVariant: request.apiVariant,
  };
}

/** Routes the Web Editor's HTTP and in-browser WebGPU implementations. */
export function createBrowserAiRouterTransport(
  options: BrowserAiRouterTransportOptions = {},
): BrowserAiTransport & {
  listModels(request: BrowserAiRequest): Promise<AiModel[]>;
} {
  const httpTransport = options.httpTransport ?? createBrowserAiTransport();
  const webGpuTransport =
    options.webGpuTransport ?? createWebGpuBrowserAiTransport();

  const selected = (request: BrowserAiRequest): BrowserAiTransport =>
    isWebGpuRequest(request) ? webGpuTransport : httpTransport;

  return {
    complete: (request) => selected(request).complete(request),
    completeAgent: async (request, messages, tools) => {
      if (isWebGpuRequest(request)) {
        throw new Error(
          "WebGPU browser AI currently supports chat and inline generation, not Agent tool use.",
        );
      }
      if (httpTransport.completeAgent) {
        return httpTransport.completeAgent(request, messages, tools);
      }
      return sendChatWithTools(
        request.provider,
        request.model,
        request.apiKey ?? "",
        messages,
        tools,
        "auto",
        httpOptions(request),
      );
    },
    stream: async (request, sink: BrowserAiStreamSink) => {
      const transport = selected(request);
      if (transport.stream) {
        await transport.stream(request, sink);
        return;
      }
      const response = await transport.complete(request);
      for (const block of response.blocks) {
        if (block.type === "text" || block.type === "thinking") {
          sink.text(block.content, block.type);
        }
      }
      sink.done({
        stopReason: response.stopReason,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });
    },
    listModels: async (request) => {
      if (isWebGpuRequest(request) && webGpuTransport.listModels) {
        return webGpuTransport.listModels(request);
      }
      if (!isWebGpuRequest(request) && httpTransport.listModels) {
        return httpTransport.listModels(request);
      }
      return fetchModels(request.provider, request.apiKey ?? "", request);
    },
    abort: (operation) => {
      httpTransport.abort?.(operation);
      webGpuTransport.abort?.(operation);
    },
    dispose: () => {
      httpTransport.dispose?.();
      webGpuTransport.dispose?.();
    },
  };
}
