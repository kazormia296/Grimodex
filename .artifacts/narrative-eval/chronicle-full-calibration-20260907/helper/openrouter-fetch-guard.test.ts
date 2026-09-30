import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  currentGuardHttpStatus,
  installOpenRouterFetchGuard,
  OPENROUTER_ENDPOINT,
} from "./openrouter-fetch-guard.mjs";

const MODEL = "openai/gpt-5.6-luna";
const JSON_HEADERS = { "content-type": "application/json" };

function requestBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: MODEL,
    reasoning: { effort: "max" },
    provider: {
      only: ["openai"],
      allow_fallbacks: false,
      require_parameters: true,
      max_price: { prompt: 0.25, completion: 1.5 },
    },
    messages: [{ role: "user", content: "credential-free guard test" }],
    max_tokens: 1,
    ...overrides,
  });
}

function installWith(
  underlying: typeof fetch,
  options: Record<string, unknown> = {},
) {
  globalThis.fetch = underlying;
  return installOpenRouterFetchGuard(options);
}

async function expectFixedError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("OpenRouter Luna max transport guard", () => {
  it("allows all eighteen bounded JSON POSTs and rejects request nineteen", async () => {
    const underlying = vi.fn<typeof fetch>(
      async () => new Response('{"choices":[]}', { status: 200 }),
    );
    const handle = installWith(underlying);
    try {
      for (let index = 0; index < 18; index += 1) {
        const response = await fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        });
        expect(response).toBeInstanceOf(Response);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(await response.text()).toBe('{"choices":[]}');
      }
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_REQUEST_BUDGET_EXHAUSTED",
      );
      expect(underlying).toHaveBeenCalledTimes(18);
      expect(handle.state.admittedRequests).toBe(18);
      expect(handle.state.blockedRequests).toBe(1);
      expect(handle.state.calls).toHaveLength(18);
      expect(handle.state.calls[0]?.invocationIndex).toBe(1);
      expect(handle.state.calls[17]?.invocationIndex).toBe(18);
      const firstBody = underlying.mock.calls[0]?.[1]?.body;
      expect(handle.state.calls[0]?.requestDigest).toBe(
        `sha256:${createHash("sha256")
          .update(firstBody as string)
          .digest("hex")}`,
      );
    } finally {
      handle.restore();
    }
  });

  it("enforces the exact endpoint, POST method, redirect error, JSON body, and Luna routing", async () => {
    const underlying = vi.fn(async () => new Response("ok", { status: 200 }));
    const handle = installWith(underlying);
    try {
      await expectFixedError(
        fetch("https://example.test/chat", {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_UNEXPECTED_OPENROUTER_REQUEST",
      );
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "GET",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_UNEXPECTED_OPENROUTER_REQUEST",
      );
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "follow",
          body: requestBody(),
        }),
        "LIVE_JUDGE_UNEXPECTED_OPENROUTER_REQUEST",
      );
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: JSON.stringify({
            ...JSON.parse(requestBody()),
            model: "openai/gpt-5.6-sol",
          }),
        }),
        "LIVE_JUDGE_REQUEST_BODY_INVALID",
      );
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: JSON.stringify({
            ...JSON.parse(requestBody()),
            reasoning: { effort: "medium" },
          }),
        }),
        "LIVE_JUDGE_REQUEST_BODY_INVALID",
      );
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: JSON.stringify({
            ...JSON.parse(requestBody()),
            provider: {
              only: ["openai"],
              allow_fallbacks: true,
              require_parameters: true,
              max_price: { prompt: 0.25, completion: 1.5 },
            },
          }),
        }),
        "LIVE_JUDGE_REQUEST_BODY_INVALID",
      );
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: JSON.stringify({
            ...JSON.parse(requestBody()),
            provider: {
              only: ["openai"],
              allow_fallbacks: false,
              require_parameters: true,
              max_price: { prompt: 0.26, completion: 1.5 },
            },
          }),
        }),
        "LIVE_JUDGE_REQUEST_BODY_INVALID",
      );
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: "not-json",
        }),
        "LIVE_JUDGE_REQUEST_BODY_INVALID",
      );
      expect(underlying).not.toHaveBeenCalled();
      expect(handle.state.admittedRequests).toBe(0);
      expect(handle.state.blockedRequests).toBe(8);
    } finally {
      handle.restore();
    }
  });

  it("adds the JSON content type and sends only a string body", async () => {
    const underlying = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect(typeof init?.body).toBe("string");
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/json",
        );
        return new Response('{"ok":true}', {
          status: 200,
          headers: JSON_HEADERS,
        });
      },
    );
    const handle = installWith(underlying);
    try {
      const body = requestBody();
      const response = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        redirect: "error",
        body,
      });
      expect(await response.json()).toEqual({ ok: true });
      const bodyBytes = Buffer.byteLength(body, "utf8");
      const maxTokens = JSON.parse(body).max_tokens;
      const expectedCost =
        ((bodyBytes + 1024) * 0.25) / 1_000_000 + (maxTokens * 1.5) / 1_000_000;
      expect(handle.state.reservedCostUsd).toBe(expectedCost);
    } finally {
      handle.restore();
    }
  });

  it("rejects nonfinite, excessive, or otherwise unsafe limits before fetch", async () => {
    const underlying = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = underlying;
    expect(() => installOpenRouterFetchGuard({ maxRequests: 19 })).toThrow(
      "LIVE_JUDGE_LIMIT_INVALID",
    );
    expect(() => installOpenRouterFetchGuard({ maxRuntimeMs: 180001 })).toThrow(
      "LIVE_JUDGE_LIMIT_INVALID",
    );
    expect(() =>
      installOpenRouterFetchGuard({ maxResponseBytes: 2_000_001 }),
    ).toThrow("LIVE_JUDGE_LIMIT_INVALID");
    expect(() =>
      installOpenRouterFetchGuard({ maxInputTokens: 65_537 }),
    ).toThrow("LIVE_JUDGE_LIMIT_INVALID");
    expect(() =>
      installOpenRouterFetchGuard({ maxOutputTokens: 8_193 }),
    ).toThrow("LIVE_JUDGE_LIMIT_INVALID");
    expect(() =>
      installOpenRouterFetchGuard({ budgetUsd: Number.NaN }),
    ).toThrow("LIVE_JUDGE_LIMIT_INVALID");
    expect(() =>
      installOpenRouterFetchGuard({ budgetUsd: Number.POSITIVE_INFINITY }),
    ).toThrow("LIVE_JUDGE_LIMIT_INVALID");
    expect(underlying).not.toHaveBeenCalled();
  });

  it("reserves input plus UTF-8 safety bytes and output max_tokens before POST", async () => {
    const underlying = vi.fn(async () => new Response("ok", { status: 200 }));
    const handle = installWith(underlying, {
      maxInputTokens: 16,
      maxOutputTokens: 2,
    });
    try {
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody({
            max_tokens: 2,
            messages: [{ role: "user", content: "x".repeat(200) }],
          }),
        }),
        "LIVE_JUDGE_INPUT_LIMIT_EXCEEDED",
      );
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody({ max_tokens: 3 }),
        }),
        "LIVE_JUDGE_REQUEST_BODY_INVALID",
      );
      expect(handle.state.admittedRequests).toBe(0);
      expect(handle.state.reservedCostUsd).toBe(0);
      expect(underlying).not.toHaveBeenCalled();
    } finally {
      handle.restore();
    }
  });

  it("rejects a request when full UTF-8 bytes plus the margin exceed the input cap", async () => {
    const body = requestBody({
      messages: [{ role: "user", content: "x".repeat(64_600) }],
    });
    const bodyBytes = Buffer.byteLength(body, "utf8");
    expect(bodyBytes + 1_024).toBeGreaterThan(65_536);
    expect(Math.ceil(bodyBytes / 2) + 1_024).toBeLessThanOrEqual(65_536);
    const underlying = vi.fn(async () => new Response("ok", { status: 200 }));
    const handle = installWith(underlying);
    try {
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body,
        }),
        "LIVE_JUDGE_INPUT_LIMIT_EXCEEDED",
      );
      expect(underlying).not.toHaveBeenCalled();
      expect(handle.state.admittedRequests).toBe(0);
      expect(handle.state.reservedCostUsd).toBe(0);
    } finally {
      handle.restore();
    }
  });

  it("rejects a cumulative reservation overflow without refunding a failed attempt", async () => {
    const underlying = vi.fn(async () => {
      throw new Error("provider detail must not escape");
    });
    const handle = installWith(underlying, { budgetUsd: 0.0005 });
    try {
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_FETCH_REJECTED",
      );
      const reserved = handle.state.reservedCostUsd;
      expect(reserved).toBeGreaterThan(0);
      expect(handle.state.admittedRequests).toBe(1);
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_BUDGET_EXCEEDED",
      );
      expect(handle.state.reservedCostUsd).toBe(reserved);
      expect(handle.state.admittedRequests).toBe(1);
      expect(underlying).toHaveBeenCalledTimes(1);
    } finally {
      handle.restore();
    }
  });

  it("bounds HTTP failure bodies before returning a fixed error and never retries", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2_000_001));
      },
      cancel() {
        cancelled = true;
      },
    });
    const underlying = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("bad request", { status: 500 }))
      .mockResolvedValueOnce(new Response(stream, { status: 302 }));
    const handle = installWith(underlying);
    try {
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_HTTP_FAILURE",
      );
      expect(currentGuardHttpStatus()).toBe(500);
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_RESPONSE_TOO_LARGE",
      );
      expect(cancelled).toBe(true);
      expect(underlying).toHaveBeenCalledTimes(2);
    } finally {
      handle.restore();
    }
  });

  it("finishes a never-resolving transport and body reader by the deadline", async () => {
    const transport = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>(() => {}),
    );
    const handle = installWith(transport, { maxRuntimeMs: 20 });
    try {
      const started = Date.now();
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_FETCH_TIMEOUT",
      );
      expect(Date.now() - started).toBeLessThan(500);
      expect(handle.state.admittedRequests).toBe(1);
    } finally {
      handle.restore();
    }

    let readerCancelled = false;
    const reader = {
      read: vi.fn(
        () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}),
      ),
      cancel: vi.fn(() => {
        readerCancelled = true;
        return Promise.resolve();
      }),
      releaseLock: vi.fn(),
    };
    const bodyReaderResponse = {
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    const bodyTransport = vi.fn(async () => bodyReaderResponse);
    const bodyHandle = installWith(bodyTransport, { maxRuntimeMs: 20 });
    try {
      await expectFixedError(
        fetch(OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_FETCH_TIMEOUT",
      );
      expect(reader.cancel).toHaveBeenCalledTimes(1);
      expect(readerCancelled).toBe(true);
      expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    } finally {
      bodyHandle.restore();
    }
  });

  it("uses fixed sanitized progress records and an exclusive 0600 owned file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chronicle-luna-guard-"));
    chmodSync(directory, 0o700);
    const progressPath = join(directory, "progress.json");
    const underlying = vi.fn(
      async () => new Response('{"ok":true}', { status: 200 }),
    );
    const handle = installWith(underlying, { progressPath });
    try {
      expect(statSync(progressPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(progressPath, "utf8")).toContain('"status":"ready"');
      await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        redirect: "error",
        body: requestBody(),
        headers: { authorization: "Bearer secret-canary" },
      });
      const progress = readFileSync(progressPath, "utf8");
      expect(progress).toContain('"status":"response-accepted"');
      expect(progress).not.toContain("secret-canary");
      expect(progress).not.toContain(MODEL);
      expect(progress).not.toContain("credential-free guard test");
    } finally {
      handle.restore();
    }

    const existingPath = join(directory, "existing-progress.json");
    writeFileSync(existingPath, "preserve-me\n", { mode: 0o600 });
    expect(() =>
      installOpenRouterFetchGuard({ progressPath: existingPath }),
    ).toThrow("LIVE_JUDGE_PROGRESS_CREATE_FAILED");
    expect(readFileSync(existingPath, "utf8")).toBe("preserve-me\n");
    mkdirSync(join(directory, "nested"));
  });

  it("fails closed when the initial ready progress record cannot be synced", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        fsyncSync: vi.fn(() => {
          throw new Error("injected progress sync failure");
        }),
      };
    });
    const isolated = await import("./openrouter-fetch-guard.mjs");
    const underlying = vi.fn<typeof fetch>(
      async () => new Response("ok", { status: 200 }),
    );
    const previousFetch = globalThis.fetch;
    globalThis.fetch = underlying;
    const directory = mkdtempSync(join(tmpdir(), "chronicle-luna-progress-failure-"));
    chmodSync(directory, 0o700);
    try {
      expect(() =>
        isolated.installOpenRouterFetchGuard({
          progressPath: join(directory, "progress.json"),
        }),
      ).toThrow("LIVE_JUDGE_PROGRESS_WRITE_FAILED");
      expect(underlying).not.toHaveBeenCalled();
      expect(globalThis[isolated.FETCH_GUARD_STATE]).toBeUndefined();
    } finally {
      globalThis.fetch = previousFetch;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("blocks later POSTs after a request-started or response progress sync failure", async () => {
    vi.resetModules();
    let syncCount = 0;
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        fsyncSync: vi.fn(() => {
          syncCount += 1;
          if (syncCount === 2 || syncCount === 3) {
            throw new Error("injected progress sync failure");
          }
        }),
      };
    });
    const isolated = await import("./openrouter-fetch-guard.mjs");
    const underlying = vi.fn<typeof fetch>(
      async () => new Response("ok", { status: 200 }),
    );
    const previousFetch = globalThis.fetch;
    globalThis.fetch = underlying;
    const directory = mkdtempSync(join(tmpdir(), "chronicle-luna-progress-failure-"));
    chmodSync(directory, 0o700);
    const handle = isolated.installOpenRouterFetchGuard({
      progressPath: join(directory, "progress.json"),
    });
    try {
      await expectFixedError(
        fetch(isolated.OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_PROGRESS_WRITE_FAILED",
      );
      expect(underlying).not.toHaveBeenCalled();
      await expectFixedError(
        fetch(isolated.OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_PROGRESS_WRITE_FAILED",
      );
      expect(underlying).not.toHaveBeenCalled();
      expect(handle.state.admittedRequests).toBe(1);
      expect(handle.state.blockedRequests).toBe(1);
    } finally {
      handle.restore();
      globalThis.fetch = previousFetch;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("blocks later POSTs when a response progress sync fails after fetch", async () => {
    vi.resetModules();
    let syncCount = 0;
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        fsyncSync: vi.fn(() => {
          syncCount += 1;
          if (syncCount === 3) {
            throw new Error("injected progress sync failure");
          }
        }),
      };
    });
    const isolated = await import("./openrouter-fetch-guard.mjs");
    const underlying = vi.fn<typeof fetch>(
      async () => new Response("ok", { status: 200 }),
    );
    const previousFetch = globalThis.fetch;
    globalThis.fetch = underlying;
    const directory = mkdtempSync(join(tmpdir(), "chronicle-luna-progress-failure-"));
    chmodSync(directory, 0o700);
    const handle = isolated.installOpenRouterFetchGuard({
      progressPath: join(directory, "progress.json"),
    });
    try {
      await expectFixedError(
        fetch(isolated.OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_PROGRESS_WRITE_FAILED",
      );
      expect(underlying).toHaveBeenCalledTimes(1);
      await expectFixedError(
        fetch(isolated.OPENROUTER_ENDPOINT, {
          method: "POST",
          redirect: "error",
          body: requestBody(),
        }),
        "LIVE_JUDGE_PROGRESS_WRITE_FAILED",
      );
      expect(underlying).toHaveBeenCalledTimes(1);
      expect(handle.state.admittedRequests).toBe(1);
      expect(handle.state.blockedRequests).toBe(1);
    } finally {
      handle.restore();
      globalThis.fetch = previousFetch;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
