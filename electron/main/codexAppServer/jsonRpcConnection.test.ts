import { describe, expect, it, vi } from "vitest";

import { JsonRpcConnection } from "./jsonRpcConnection.js";

class FakeWire {
  readonly writes: string[] = [];
  private dataListeners = new Set<(chunk: string) => void>();
  private closeListeners = new Set<(cause?: Error) => void>();
  private errorListeners = new Set<(cause: Error) => void>();

  write(line: string): void {
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

    wire.emitData(`{"jsonrpc":"2.0","id":${sent.id},"res`);
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
        jsonrpc: "2.0",
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
        jsonrpc: "2.0",
        id: first.id,
        error: { code: -32001, message: "Server overloaded; retry later." },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(wire.writes).toHaveLength(2);
    const second = JSON.parse(wire.writes[1]!) as { id: number };
    wire.emitData(
      JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { ok: true } }) +
        "\n",
    );
    await expect(request).resolves.toEqual({ ok: true });
    connection.dispose();
    vi.useRealTimers();
  });

  it("rejects unknown server requests instead of leaving a turn blocked", async () => {
    const wire = new FakeWire();
    const connection = new JsonRpcConnection(wire, { requestTimeoutMs: 1000 });
    wire.emitData(
      JSON.stringify({
        jsonrpc: "2.0",
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
});
