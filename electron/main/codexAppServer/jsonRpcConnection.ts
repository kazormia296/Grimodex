import { StringDecoder } from "node:string_decoder";

import {
  parseJsonRpcLine,
  serializeJsonRpcMessage,
  type JsonRpcErrorShape,
  type JsonRpcId,
  type JsonRpcMessage,
} from "../../shared/codexAppProtocol.js";

export interface JsonRpcWire {
  write(line: string): void;
  onData(listener: (chunk: Buffer | string) => void): () => void;
  onClose(listener: (cause?: Error) => void): () => void;
  onError(listener: (cause: Error) => void): () => void;
  close(): void;
}

export interface JsonRpcRequestOptions {
  retry?: boolean;
  maxRetries?: number;
}

export interface JsonRpcConnectionOptions {
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  maxBufferedBytes?: number;
  retryBaseDelayMs?: number;
  random?: () => number;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (
    method: string,
    id: JsonRpcId,
    params: unknown,
  ) => Promise<unknown>;
  onUnknownMessage?: (message: JsonRpcMessage) => void;
  onClosed?: (cause?: Error) => void;
}

export class JsonRpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorShape) {
    super(error.message);
    this.name = "JsonRpcRemoteError";
    this.code = error.code;
    this.data = error.data;
  }
}

interface PendingRequest {
  method: string;
  params: unknown;
  resolve: (value: unknown) => void;
  reject: (cause: Error) => void;
  retry: boolean;
  maxRetries: number;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;

/** JSONL JSON-RPC connection with request correlation and fail-closed limits. */
export class JsonRpcConnection {
  private readonly decoder = new StringDecoder("utf8");
  private pendingText = "";
  private bufferedBytes = 0;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly options: Required<
    Pick<
      JsonRpcConnectionOptions,
      | "requestTimeoutMs"
      | "maxLineBytes"
      | "maxBufferedBytes"
      | "retryBaseDelayMs"
      | "random"
    >
  > &
    Omit<
      JsonRpcConnectionOptions,
      | "requestTimeoutMs"
      | "maxLineBytes"
      | "maxBufferedBytes"
      | "retryBaseDelayMs"
      | "random"
    >;
  private readonly unlisten: Array<() => void>;

  constructor(
    private readonly wire: JsonRpcWire,
    options: JsonRpcConnectionOptions = {},
  ) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      random: options.random ?? Math.random,
      onNotification: options.onNotification,
      onServerRequest: options.onServerRequest,
      onUnknownMessage: options.onUnknownMessage,
      onClosed: options.onClosed,
    };
    this.unlisten = [
      wire.onData((chunk) => this.handleData(chunk)),
      wire.onClose((cause) => this.handleClose(cause)),
      wire.onError((cause) => this.handleClose(cause)),
    ];
  }

  request(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server connection is closed"));
    }
    if (!method.trim()) return Promise.reject(new Error("RPC method is empty"));

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        params,
        resolve,
        reject,
        retry: Boolean(options.retry) && method !== "turn/start",
        maxRetries: Math.max(0, options.maxRetries ?? 3),
        retries: 0,
        timer: null,
      };
      this.sendPending(pending);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) throw new Error("Codex app-server connection is closed");
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const remove of this.unlisten) remove();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server connection disposed"));
    }
    this.pending.clear();
    this.wire.close();
  }

  private sendPending(pending: PendingRequest): void {
    if (this.closed) {
      pending.reject(new Error("Codex app-server connection is closed"));
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, pending);
    this.write({
      jsonrpc: "2.0",
      id,
      method: pending.method,
      ...(pending.params === undefined ? {} : { params: pending.params }),
    });
    pending.timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        new Error(`Codex app-server request timed out: ${pending.method}`),
      );
    }, this.options.requestTimeoutMs);
    pending.timer.unref?.();
  }

  private write(message: Record<string, unknown>): void {
    this.wire.write(serializeJsonRpcMessage(message));
  }

  private handleData(chunk: Buffer | string): void {
    if (this.closed) return;
    const bytes = Buffer.isBuffer(chunk)
      ? chunk.byteLength
      : Buffer.byteLength(chunk, "utf8");
    this.bufferedBytes += bytes;
    if (this.bufferedBytes > this.options.maxBufferedBytes) {
      this.handleClose(
        new Error("Codex app-server output exceeds total byte limit"),
      );
      return;
    }
    this.pendingText += Buffer.isBuffer(chunk)
      ? this.decoder.write(chunk)
      : chunk;
    let newline = this.pendingText.indexOf("\n");
    try {
      while (newline >= 0) {
        const line = this.pendingText.slice(0, newline).replace(/\r$/u, "");
        this.pendingText = this.pendingText.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > this.options.maxLineBytes) {
          throw new Error("Codex app-server JSONL line exceeds byte limit");
        }
        if (line.trim()) this.handleMessage(parseJsonRpcLine(line));
        newline = this.pendingText.indexOf("\n");
      }
      if (
        Buffer.byteLength(this.pendingText, "utf8") > this.options.maxLineBytes
      ) {
        throw new Error("Codex app-server JSONL line exceeds byte limit");
      }
    } catch (cause) {
      this.handleClose(
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ("method" in message && "id" in message) {
      const handler = this.options.onServerRequest;
      if (!handler) {
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Server request is not supported" },
        });
        return;
      }
      void handler(message.method, message.id, message.params)
        .then((result) => {
          this.write({ jsonrpc: "2.0", id: message.id, result });
        })
        .catch((cause: unknown) => {
          this.write({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message: cause instanceof Error ? cause.message : String(cause),
            },
          });
        });
      return;
    }
    if ("method" in message) {
      this.options.onNotification?.(message.method, message.params);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.options.onUnknownMessage?.(message);
      return;
    }
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if ("error" in message) {
      const error = new JsonRpcRemoteError(message.error);
      if (
        error.code === -32001 &&
        pending.retry &&
        pending.retries < pending.maxRetries &&
        !this.closed
      ) {
        pending.retries += 1;
        const exponential =
          this.options.retryBaseDelayMs * 2 ** (pending.retries - 1);
        const jitter = Math.floor(
          this.options.random() * this.options.retryBaseDelayMs,
        );
        const delay = exponential + jitter;
        pending.timer = setTimeout(() => this.sendPending(pending), delay);
        pending.timer.unref?.();
        return;
      }
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }

  private handleClose(cause?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const remove of this.unlisten) remove();
    const error = cause ?? new Error("Codex app-server process closed");
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.options.onClosed?.(error);
  }
}
