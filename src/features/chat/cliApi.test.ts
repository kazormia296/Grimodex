import { beforeEach, describe, expect, it, vi } from "vitest";

type ListenHandler = (payload: unknown) => void;

const listeners = new Map<string, ListenHandler>();
const callOrder: string[] = [];
const invokeMock = vi.fn(async (command: string) => {
  callOrder.push(`invoke:${command}`);
  return undefined;
});
const listenMock = vi.fn(async (event: string, handler: ListenHandler) => {
  callOrder.push(`listen:${event}`);
  listeners.set(event, handler);
  return () => {
    if (listeners.get(event) === handler) listeners.delete(event);
  };
});

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: (...args: unknown[]) =>
    listenMock(...(args as [string, ListenHandler])),
}));

import {
  abortCliChatStream,
  detectCliBinary,
  listCliModels,
  sendCliChatStream,
  testCliConnection,
} from "./cliApi";

function emit(event: string, payload: unknown): void {
  listeners.get(event)?.(payload);
}

describe("chat/cliApi", () => {
  beforeEach(() => {
    listeners.clear();
    callOrder.length = 0;
    invokeMock.mockClear();
    listenMock.mockClear();
  });

  it("3 listenerを先に登録し、camelCase payloadでCLI streamを開始する", async () => {
    const callbacks = {
      onTextDelta: vi.fn(),
      onThinkingDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    const payload = {
      cli: "codex" as const,
      binaryPath: "/opt/codex",
      model: "gpt-5",
      prompt: "hello",
    };

    const cleanup = await sendCliChatStream(payload, callbacks);

    expect(callOrder).toEqual([
      "listen:cli:stream-chunk",
      "listen:cli:stream-done",
      "listen:cli:stream-error",
      "invoke:send_cli_chat_stream",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("send_cli_chat_stream", {
      payload,
    });

    emit("cli:stream-chunk", { delta: "text", block_type: "text" });
    emit("cli:stream-chunk", { delta: "think", block_type: "thinking" });
    emit("cli:stream-done", {
      stop_reason: "end_turn",
      input_tokens: 12,
      output_tokens: 4,
    });
    emit("cli:stream-error", { message: "boom" });

    expect(callbacks.onTextDelta).toHaveBeenCalledWith("text");
    expect(callbacks.onThinkingDelta).toHaveBeenCalledWith("think");
    expect(callbacks.onDone).toHaveBeenCalledWith({
      stopReason: "end_turn",
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(callbacks.onError).toHaveBeenCalledWith("boom");

    cleanup();
    expect(listeners.size).toBe(0);
  });

  it("invoke rejectもonErrorへ渡す", async () => {
    invokeMock.mockRejectedValueOnce(new Error("spawn failed"));
    const onError = vi.fn();
    await sendCliChatStream(
      { cli: "claude", prompt: "hello" },
      {
        onTextDelta: vi.fn(),
        onThinkingDelta: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
    );
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith("spawn failed"),
    );
  });

  it("abort/detect/testは正確なcommand shapeを使う", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("/usr/local/bin/claude")
      .mockResolvedValueOnce("claude 1.2.3");

    await abortCliChatStream();
    await expect(detectCliBinary("claude")).resolves.toBe(
      "/usr/local/bin/claude",
    );
    await expect(testCliConnection("/usr/local/bin/claude")).resolves.toBe(
      "claude 1.2.3",
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "abort_cli_chat_stream");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "detect_cli_binary", {
      cli: "claude",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "test_cli_connection", {
      binaryPath: "/usr/local/bin/claude",
    });
  });

  it("model一覧は空pathをnullへ正規化する", async () => {
    const models = [{ id: "opus", name: "Opus" }];
    invokeMock.mockResolvedValueOnce(models);

    await expect(listCliModels("claude", "")).resolves.toEqual(models);
    expect(invokeMock).toHaveBeenCalledWith("list_cli_models", {
      cli: "claude",
      binaryPath: null,
    });
  });
});
