// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserMock } from "./browser-mock";

describe("BrowserMock web AI runtime contract", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the structured chat payload expected by the real editor", async () => {
    const authorizeAiRequest = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue({
      blocks: [{ type: "text", content: "real response" }],
      stopReason: "end_turn",
      inputTokens: 4,
      outputTokens: 2,
    });
    const mock = await createBrowserMock({
      authorizeAiRequest,
      aiTransport: { complete },
    });

    const result = await mock.invoke<{
      blocks: Array<{ type: string; content: string }>;
      stopReason: string;
    }>("send_chat_message", {
      messages: [{ role: "user", content: "hello" }],
      provider: "openai",
      model: "gpt-4.1-mini",
      endpointId: "primary",
    });

    expect(authorizeAiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "chat", provider: "openai" }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "chat",
        provider: "openai",
        model: "gpt-4.1-mini",
        endpointId: "primary",
      }),
    );
    expect(result).toEqual({
      blocks: [{ type: "text", content: "real response" }],
      stopReason: "end_turn",
      inputTokens: 4,
      outputTokens: 2,
    });
  });

  it("does not reach the provider when consent authorization fails", async () => {
    const complete = vi.fn();
    const mock = await createBrowserMock({
      authorizeAiRequest: vi
        .fn()
        .mockRejectedValue(new Error("ai-data-consent-required")),
      aiTransport: { complete },
    });

    await expect(
      mock.invoke("send_chat_message", {
        messages: [{ role: "user", content: "private manuscript" }],
      }),
    ).rejects.toThrow("ai-data-consent-required");
    expect(complete).not.toHaveBeenCalled();
  });

  it("emits the existing chat stream wire and can abort it", async () => {
    let releaseStream: (() => void) | undefined;
    const stream = vi.fn(
      async (
        _request: unknown,
        sink: {
          text(delta: string): void;
          done(payload: {
            stopReason: string;
            inputTokens?: number;
            outputTokens?: number;
          }): void;
        },
      ) => {
        sink.text("本物");
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        sink.done({ stopReason: "end_turn", inputTokens: 3, outputTokens: 1 });
      },
    );
    const abort = vi.fn(() => releaseStream?.());
    const mock = await createBrowserMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream, abort },
    });
    const chunks: unknown[] = [];
    const done: unknown[] = [];
    window.addEventListener("chat:stream-chunk", (event) => {
      chunks.push((event as CustomEvent).detail);
    });
    window.addEventListener("chat:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });

    const running = mock.invoke("send_chat_message_stream", {
      messages: [{ role: "user", content: "continue" }],
    });
    await vi.waitFor(() =>
      expect(chunks).toEqual([{ delta: "本物", block_type: "text" }]),
    );
    await mock.invoke("abort_chat_stream");
    await running;

    expect(abort).toHaveBeenCalledWith("chat");
    expect(done).toEqual([
      { stop_reason: "end_turn", input_tokens: 3, output_tokens: 1 },
    ]);
  });

  it("emits inline AI events instead of resolving as a no-op", async () => {
    const stream = vi.fn(
      async (
        request: { operation: string },
        sink: {
          text(delta: string): void;
          done(payload: { stopReason: string }): void;
        },
      ) => {
        expect(request.operation).toBe("inline");
        sink.text("続き");
        sink.done({ stopReason: "end_turn" });
      },
    );
    const mock = await createBrowserMock({
      authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      aiTransport: { complete: vi.fn(), stream, abort: vi.fn() },
    });
    const chunks: unknown[] = [];
    const done: unknown[] = [];
    window.addEventListener("inline-ai:stream-chunk", (event) => {
      chunks.push((event as CustomEvent).detail);
    });
    window.addEventListener("inline-ai:stream-done", (event) => {
      done.push((event as CustomEvent).detail);
    });

    await mock.invoke("send_inline_ai_stream", {
      messages: [{ role: "user", content: "continue" }],
    });

    expect(chunks).toEqual([{ delta: "続き", block_type: "text" }]);
    expect(done).toEqual([
      {
        stop_reason: "end_turn",
        input_tokens: null,
        output_tokens: null,
      },
    ]);
  });
});
