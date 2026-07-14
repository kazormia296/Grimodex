import { describe, expect, it, vi } from "vitest";

import { JsonRpcConnection } from "./jsonRpcConnection.js";

class FakeWire {
  readonly writes: string[] = [];
  closeCalls = 0;
  writeCalls = 0;
  writeFailure: { call: number; cause: Error } | null = null;
  private dataListeners = new Set<(chunk: string) => void>();
  private closeListeners = new Set<(cause?: Error) => void>();
  private errorListeners = new Set<(cause: Error) => void>();

  write(line: string): void {
    this.writeCalls += 1;
    if (this.writeFailure?.call === this.writeCalls) {
      throw this.writeFailure.cause;
    }
    this.writes.push(line);
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: (cause?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (cause: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  close(): void {
    this.closeCalls += 1;
    this.emitClose();
  }

  emitData(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk);
  }

  emitClose(cause?: Error): void {
    for (const listener of this.closeListeners) listener(cause);
  }

  emitError(cause: Error): void {
    for (const listener of this.errorListeners) listener(cause);
  }
}

describe("JsonRpcConnection", () => {
  it("handles split JSONL chunks and correlates responses", async () => {
    const wire = new FakeWire();
    const connection = new JsonRpcConnection(wire, { requestTimeoutMs: 1000 });
    const request = connection.request("model/list", {});
    expect(wire.writes).toHaveLength(1);
    const sent = JSON.parse(wire.writes[0]!) as { id: number };

    wire.emitData(`{"id":${sent.id},"res`);
    wire.emitData('ult":{"models":[{"id":"gpt"}]}}\r\n');

    await expect(request).resolves.toEqual({ models: [{ id: "gpt" }] });
    connection.dispose();
  });

  it("rejects pending requests when the process closes", async () => {
    const wire = new FakeWire();
    const connection = new JsonRpcConnection(wire, { requestTimeoutMs: 1000 });
    const request = connection.request("thread/start", {});
    wire.emitClose(new Error("crashed"));
    await expect(request).rejects.toThrow("crashed");
  });

  it("closes and clears pending state when the initial write throws", async () => {
    const wire = new FakeWire();
    wire.writeFailure = { call: 1, cause: new Error("stdin is closed") };
    const onClosed = vi.fn();
    const connection = new JsonRpcConnection(wire, {
      requestTimeoutMs: 1000,
      onClosed,
    });

    const request = connection.request("model/list", {});

    await expect(request).rejects.toThrow("stdin is closed");
    expect(wire.writeCalls).toBe(1);
    expect(wire.writes).toHaveLength(0);
    expect(wire.closeCalls).toBe(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(
      (
        connection as unknown as {
          pending: Map<unknown, unknown>;
        }
      ).pending.size,
    ).toBe(0);
    await expect(connection.request("model/list", {})).rejects.toThrow(
      "connection is closed",
    );
  });

  it("does not retry turn/start after an overloaded response", async () => {
    vi.useFakeTimers();
    const wire = new FakeWire();
    const connection = new JsonRpcConnection(wire, {
      requestTimeoutMs: 1000,
      retryBaseDelayMs: 1,
    });
    const request = connection.request("turn/start", {}, { retry: true });
    const first = JSON.parse(wire.writes[0]!) as { id: number };
    wire.emitData(
      JSON.stringify({
        id: first.id,
        error: { code: -32001, message: "Server overloaded; retry later." },
      }) + "\n",
    );
    await expect(request).rejects.toThrow("overloaded");
    expect(wire.writes).toHaveLength(1);
    vi.useRealTimers();
  });

  it("retries idempotent requests on -32001 with jitter disabled in tests", async () => {
    vi.useFakeTimers();
    const wire = new FakeWire();
    const connection = new JsonRpcConnection(wire, {
      requestTimeoutMs: 1000,
      retryBaseDelayMs: 10,
      random: () => 0,
    });
    const request = connection.request("model/list", {}, { retry: true });
    const first = JSON.parse(wire.writes[0]!) as { id: number };
    wire.emitData(
      JSON.stringify({
        id: first.id,
        error: { code: -32001, message: "Server overloaded; retry later." },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(wire.writes).toHaveLength(2);
    const second = JSON.parse(wire.writes[1]!) as { id: number };
    wire.emitData(
      JSON.stringify({ id: second.id, result: { ok: true } }) + "\n",
    );
    await expect(request).resolves.toEqual({ ok: true });
    connection.dispose();
    vi.useRealTimers();
  });

  it("rejects and closes when a retry timer write throws", async () => {
    vi.useFakeTimers();
    const wire = new FakeWire();
    wire.writeFailure = { call: 2, cause: new Error("retry write failed") };
    const onClosed = vi.fn();
    const connection = new JsonRpcConnection(wire, {
      requestTimeoutMs: 1000,
      retryBaseDelayMs: 10,
      random: () => 0,
      onClosed,
    });
    const request = connection.request("model/list", {}, { retry: true });
    const first = JSON.parse(wire.writes[0]!) as { id: number };
    wire.emitData(
      JSON.stringify({
        id: first.id,
        error: { code: -32001, message: "Server overloaded; retry later." },
      }) + "\n",
    );
    const rejection = expect(request).rejects.toThrow("retry write failed");

    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(wire.writeCalls).toBe(2);
    expect(wire.writes).toHaveLength(1);
    expect(wire.closeCalls).toBe(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(
      (
        connection as unknown as {
          pending: Map<unknown, unknown>;
        }
      ).pending.size,
    ).toBe(0);
    vi.useRealTimers();
  });

  it("rejects unknown server requests instead of leaving a turn blocked", async () => {
    const wire = new FakeWire();
    const connection = new JsonRpcConnection(wire, { requestTimeoutMs: 1000 });
    wire.emitData(
      JSON.stringify({
        id: 99,
        method: "item/commandApproval",
        params: {},
      }) + "\n",
    );
    expect(wire.writes).toHaveLength(1);
    expect(JSON.parse(wire.writes[0]!)).toMatchObject({
      id: 99,
      error: { code: -32601 },
    });
    connection.dispose();
  });

  it("limits only the currently buffered partial line, not lifetime bytes", () => {
    const wire = new FakeWire();
    const onNotification = vi.fn();
    const onClosed = vi.fn();
    new JsonRpcConnection(wire, {
      maxLineBytes: 100,
      maxBufferedBytes: 24,
      onNotification,
      onClosed,
    });

    for (let index = 0; index < 20; index += 1) {
      wire.emitData('{"method":"tick"}\n');
    }
    expect(onNotification).toHaveBeenCalledTimes(20);
    expect(onClosed).not.toHaveBeenCalled();

    wire.emitData("x".repeat(25));
    expect(onClosed).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Codex app-server output exceeds buffered byte limit",
      }),
    );
    expect(wire.closeCalls).toBe(1);
  });
});
