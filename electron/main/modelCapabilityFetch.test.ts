import { createGunzip, gzipSync } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_CAPABILITY_FETCH_HOST,
  MODEL_CAPABILITY_FETCH_URL,
  MODEL_CAPABILITY_SNAPSHOT_REPO_PATH,
  MODEL_CAPABILITY_USER_AGENT,
  fetchModelCapabilityText,
  isRetryableFetchFailure,
  type FetchLike,
  type ModelCapabilityFetchOptions,
  type ModelCapabilityFetchTimers,
} from "./modelCapabilityFetch.js";
import { makeResponse } from "./modelCapability.testSupport.js";

const MARKER = "SECRET_BODY_MARKER_41c7";

// vi の fake timers は globalThis を差し替えるので、呼び出しのたびに globalThis から引く。
const timers: ModelCapabilityFetchTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** chunk を順に流し、最後に close する stream。cancel の呼び出しを記録する。 */
function chunkStream(
  chunks: readonly (string | Uint8Array)[],
  hooks: { onCancel?: () => void; stallAfter?: boolean } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index];
        index += 1;
        controller.enqueue(
          typeof chunk === "string"
            ? encoder.encode(chunk)
            : (chunk as Uint8Array),
        );
        return;
      }
      if (hooks.stallAfter) return new Promise<void>(() => undefined);
      controller.close();
      return undefined;
    },
    cancel() {
      hooks.onCancel?.();
    },
  });
}

function options(
  fetchImpl: FetchLike,
  overrides: Partial<ModelCapabilityFetchOptions> = {},
): ModelCapabilityFetchOptions {
  return {
    fetchImpl,
    timers,
    maxBytes: 1024,
    connectTimeoutMs: 10_000,
    totalTimeoutMs: 30_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("定数", () => {
  it("取得先は raw.githubusercontent.com の master の写しで、path は同梱の写しと同じ", () => {
    expect(MODEL_CAPABILITY_FETCH_HOST).toBe("raw.githubusercontent.com");
    expect(MODEL_CAPABILITY_FETCH_URL).toBe(
      "https://raw.githubusercontent.com/kazormia296/Grimodex/master/electron/resources/model-capabilities.json",
    );
    expect(
      MODEL_CAPABILITY_FETCH_URL.endsWith(MODEL_CAPABILITY_SNAPSHOT_REPO_PATH),
    ).toBe(true);
    expect(new URL(MODEL_CAPABILITY_FETCH_URL).protocol).toBe("https:");
    expect(MODEL_CAPABILITY_USER_AGENT).toBe("Grimodex-Model-Registry");
  });
});

describe("要求の形（T3・T6）", () => {
  it("GET・redirect manual・固定の UA と Accept だけを送る（cookie・key・本文・設定は載せない）", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => makeResponse("{}"));
    await fetchModelCapabilityText(options(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as Parameters<FetchLike>;
    expect(url).toBe(MODEL_CAPABILITY_FETCH_URL);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(Object.keys(init).sort()).toEqual([
      "headers",
      "method",
      "redirect",
      "signal",
    ]);
    expect(init.headers).toEqual({
      "User-Agent": "Grimodex-Model-Registry",
      Accept: "application/json, text/plain;q=0.9",
    });
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toEqual(
      expect.arrayContaining(["cookie", "authorization"]),
    );
  });

  it("成功したら本文と byte 数を返す", async () => {
    const result = await fetchModelCapabilityText(
      options(async () => makeResponse('{"a":"あ"}')),
    );
    expect(result).toEqual({ ok: true, text: '{"a":"あ"}', bytes: 11 });
  });
});

describe("応答の検査", () => {
  it.each([
    [301, "redirect"],
    [302, "redirect"],
    [308, "redirect"],
    [404, "http-client"],
    [403, "http-client"],
    [429, "http-rate-limited"],
    [500, "http-server"],
    [503, "http-server"],
    [204, "http-other"],
    [206, "http-other"],
  ] as const)(
    "status %i は %s で失敗し、本文を読まずに閉じる",
    async (status, code) => {
      const onCancel = vi.fn();
      const result = await fetchModelCapabilityText(
        options(async () =>
          makeResponse(
            status === 204 ? null : chunkStream([MARKER], { onCancel }),
            {
              status,
              headers: { location: "https://evil.example/" },
            },
          ),
        ),
      );
      expect(result).toEqual({ ok: false, code });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    },
  );

  it.each([
    [
      "別の host",
      "https://evil.example/kazormia296/Grimodex/master/electron/resources/model-capabilities.json",
    ],
    ["http", MODEL_CAPABILITY_FETCH_URL.replace("https:", "http:")],
    ["別の path", `${MODEL_CAPABILITY_FETCH_URL}?x=1`],
    ["最終 URL が空", ""],
    [
      "host の後ろに付けた偽装",
      MODEL_CAPABILITY_FETCH_URL.replace(
        "raw.githubusercontent.com",
        "raw.githubusercontent.com.evil.example",
      ),
    ],
  ])(
    "最終 URL が定数と完全一致でなければ url-mismatch（%s）",
    async (_label, url) => {
      const onCancel = vi.fn();
      const result = await fetchModelCapabilityText(
        options(async () =>
          makeResponse(chunkStream(["{}"], { onCancel }), { url }),
        ),
      );
      expect(result).toEqual({ ok: false, code: "url-mismatch" });
      await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
    },
  );

  it("content-length が上限を超えていたら、本文を読まずに too-large", async () => {
    const onCancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        onCancel();
      },
    });
    const result = await fetchModelCapabilityText(
      options(
        async () =>
          makeResponse(stream, { headers: { "content-length": "1025" } }),
        { maxBytes: 1024 },
      ),
    );
    expect(result).toEqual({ ok: false, code: "too-large" });
    // reader を取らずに閉じる（本文は 1 byte も読まない）。
    expect(stream.locked).toBe(false);
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it("content-length が数でなくても、実際の byte 数で上限を当てる", async () => {
    const result = await fetchModelCapabilityText(
      options(
        async () =>
          makeResponse("x".repeat(2000), {
            headers: { "content-length": "abc" },
          }),
        { maxBytes: 1024 },
      ),
    );
    expect(result).toEqual({ ok: false, code: "too-large" });
  });

  it("content-length が偽って小さくても、読込み中の byte 数で打ち切り、stream を cancel する", async () => {
    const onCancel = vi.fn();
    const pulled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled();
        controller.enqueue(new Uint8Array(400));
      },
      cancel() {
        onCancel();
      },
    });
    const result = await fetchModelCapabilityText(
      options(
        async () =>
          makeResponse(stream, { headers: { "content-length": "10" } }),
        { maxBytes: 1024 },
      ),
    );
    expect(result).toEqual({ ok: false, code: "too-large" });
    // 400 byte ずつ。3 chunk 目（1200 byte）で超える。無限に読み続けない。
    expect(pulled.mock.calls.length).toBeLessThanOrEqual(4);
    expect(onCancel).toHaveBeenCalled();
  });

  it("gzip で転送された応答は、伸長後の byte 数で上限を当てる（content-length は圧縮後の小さい値）", async () => {
    // Node の fetch は伸長した stream を Response に渡し、content-length は圧縮後の値のまま残る。
    const compressed = gzipSync(Buffer.alloc(4_000_000, 0x20));
    expect(compressed.byteLength).toBeLessThan(10_000);
    let produced = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        produced += chunk.length;
        callback(null, chunk);
      },
    });
    const decompressed = Readable.toWeb(
      Readable.from([compressed]).pipe(createGunzip()).pipe(counter),
    ) as ReadableStream<Uint8Array>;
    const result = await fetchModelCapabilityText(
      options(
        async () =>
          makeResponse(decompressed, {
            headers: {
              "content-length": String(compressed.byteLength),
              "content-encoding": "gzip",
            },
          }),
        { maxBytes: 1024 },
      ),
    );
    expect(result).toEqual({ ok: false, code: "too-large" });
    // 伸長後の全体（4 MB）を読み切らずに打ち切り、stream を閉じる。
    expect(produced).toBeLessThan(1_000_000);
    await vi.waitFor(() => expect(counter.destroyed).toBe(true));
  });

  it("gzip で転送され、伸長後も上限内の応答は受ける", async () => {
    const text = '{"a":"あ"}';
    const compressed = gzipSync(Buffer.from(text, "utf8"));
    const decompressed = Readable.toWeb(
      Readable.from([compressed]).pipe(createGunzip()),
    ) as ReadableStream<Uint8Array>;
    const result = await fetchModelCapabilityText(
      options(async () =>
        makeResponse(decompressed, {
          headers: {
            "content-length": String(compressed.byteLength),
            "content-encoding": "gzip",
          },
        }),
      ),
    );
    expect(result).toEqual({ ok: true, text, bytes: 11 });
  });

  it("上限ちょうどは受ける", async () => {
    const result = await fetchModelCapabilityText(
      options(async () => makeResponse("x".repeat(1024)), { maxBytes: 1024 }),
    );
    expect(result).toMatchObject({ ok: true, bytes: 1024 });
  });

  it("UTF-8 として不正な bytes は decode で失敗する", async () => {
    const result = await fetchModelCapabilityText(
      options(async () =>
        makeResponse(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])),
      ),
    );
    expect(result).toEqual({ ok: false, code: "decode" });
  });

  it("body が無い 200 は no-body", async () => {
    const result = await fetchModelCapabilityText(
      options(async () => makeResponse(null)),
    );
    expect(result).toEqual({ ok: false, code: "no-body" });
  });

  it("fetch が投げた error の message は結果に含めない", async () => {
    const result = await fetchModelCapabilityText(
      options(async () => {
        throw new Error(`connect failed ${MARKER}`);
      }),
    );
    expect(result).toEqual({ ok: false, code: "network" });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });
});

describe("timeout と取消し", () => {
  it("接続の timeout：header が届かないまま 10 秒で timeout-connect。fetch の signal も abort される", async () => {
    let seen: AbortSignal | null = null;
    const promise = fetchModelCapabilityText(
      options(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            seen = init.signal;
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen).not.toBeNull();
    expect((seen as unknown as AbortSignal).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({
      ok: false,
      code: "timeout-connect",
    });
    expect((seen as unknown as AbortSignal).aborted).toBe(true);
  });

  it("fetch が abort を無視しても、timeout で結果を返す（待ち続けない）", async () => {
    const promise = fetchModelCapabilityText(
      options(() => new Promise<Response>(() => undefined)),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({
      ok: false,
      code: "timeout-connect",
    });
  });

  it("総時間の timeout：本文が途中で止まったら 30 秒で timeout-total。stream を cancel する", async () => {
    const onCancel = vi.fn();
    const promise = fetchModelCapabilityText(
      options(async () =>
        makeResponse(chunkStream(["{"], { onCancel, stallAfter: true })),
      ),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({
      ok: false,
      code: "timeout-total",
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it("呼び出し側の取消しで aborted。取消し済みの signal では fetch を呼ばない", async () => {
    const controller = new AbortController();
    const onCancel = vi.fn();
    const promise = fetchModelCapabilityText(
      options(
        async () =>
          makeResponse(chunkStream(["{"], { onCancel, stallAfter: true })),
        { signal: controller.signal },
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(promise).resolves.toEqual({ ok: false, code: "aborted" });
    expect(onCancel).toHaveBeenCalled();

    const fetchImpl = vi.fn<FetchLike>();
    await expect(
      fetchModelCapabilityText(
        options(fetchImpl, { signal: controller.signal }),
      ),
    ).resolves.toEqual({ ok: false, code: "aborted" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("再試行の対象", () => {
  it("一時的な失敗だけ再試行し、内容・場所の誤りは再試行しない", () => {
    for (const code of [
      "network",
      "timeout-connect",
      "timeout-total",
      "http-rate-limited",
      "http-server",
    ] as const) {
      expect(isRetryableFetchFailure(code)).toBe(true);
    }
    for (const code of [
      "aborted",
      "redirect",
      "http-client",
      "http-other",
      "url-mismatch",
      "no-body",
      "too-large",
      "decode",
    ] as const) {
      expect(isRetryableFetchFailure(code)).toBe(false);
    }
  });
});
