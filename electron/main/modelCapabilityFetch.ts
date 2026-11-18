/**
 * モデル能力の写しの取得（PR-C2）。通信の形だけを持ち、検証・保存・周期は持たない。
 * 設計の正本は docs/plans/model-capability-runtime-fetch-precheck.md の §1（A1）・§3.3（T3・T4・T6・T8）と §7。
 *
 * 通信の形（承認済みの仕様から外れない）：
 *   - 送信先は `MODEL_CAPABILITY_FETCH_URL` の 1 つだけ。https の完全一致。設定・IPC・env・renderer から
 *     変える入口は作らない（T8）。取得先の選択（models.dev の直接取得）はこの PR では作らない（Q16）。
 *   - Node の `globalThis.fetch` を使う。Electron の `net.fetch` は、RS-1 の resolver の規則と blackhole の
 *     proxy で落ちる（Q15 の probe の結果）。この module は electron を import しない。
 *   - redirect は辿らない（`manual`）。200 以外は失敗。応答の後に最終 URL を定数の URL と完全一致で再照合する。
 *   - content-length と、読み込み中の実際の byte 数の両方で上限を当てる（圧縮された応答は伸長後の byte 数で数える）。
 *   - 送るのは GET と固定の User-Agent（版なし）と Accept だけ。cookie・key・本文・設定・workspace の情報は
 *     載せない（T6）。届くのは IP と UA だけ。
 *   - 失敗は固定の code で返す。応答の本文、URL、error の message は error・log に含めない。
 */

/** 配信元の host（完全一致で照合する）。 */
export const MODEL_CAPABILITY_FETCH_HOST = "raw.githubusercontent.com";

/** 同梱の写しの repo 内の path。master の raw 配信の path と同じ（scripts/generate-model-capability-snapshot.mjs と試験が一致を確かめる）。 */
export const MODEL_CAPABILITY_SNAPSHOT_REPO_PATH =
  "electron/resources/model-capabilities.json";

/** 取得する URL（master の raw 配信）。定数で、設定・env・IPC から変えない。 */
export const MODEL_CAPABILITY_FETCH_URL = `https://${MODEL_CAPABILITY_FETCH_HOST}/kazormia296/Grimodex/master/${MODEL_CAPABILITY_SNAPSHOT_REPO_PATH}`;

/** 固定の User-Agent（版を含まない汎用名。Q6）。 */
export const MODEL_CAPABILITY_USER_AGENT = "Grimodex-Model-Registry";

/** 取得の失敗の code（応答の本文は含めない）。 */
export const MODEL_CAPABILITY_FETCH_FAILURE_CODES = [
  "aborted",
  "timeout-connect",
  "timeout-total",
  "network",
  "redirect",
  "http-client",
  "http-rate-limited",
  "http-server",
  "http-other",
  "url-mismatch",
  "no-body",
  "too-large",
  "decode",
] as const;
export type ModelCapabilityFetchFailureCode =
  (typeof MODEL_CAPABILITY_FETCH_FAILURE_CODES)[number];

/** 再試行に値する失敗（一時的なもの）。内容・場所の誤りは、待っても直らないので再試行しない。 */
export function isRetryableFetchFailure(
  code: ModelCapabilityFetchFailureCode,
): boolean {
  return (
    code === "network" ||
    code === "timeout-connect" ||
    code === "timeout-total" ||
    code === "http-rate-limited" ||
    code === "http-server"
  );
}

export type FetchLike = (
  input: string,
  init: {
    method: "GET";
    redirect: "manual";
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface ModelCapabilityFetchTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ModelCapabilityFetchOptions {
  readonly fetchImpl: FetchLike;
  readonly timers: ModelCapabilityFetchTimers;
  /** 応答の本文の上限 byte 数（policy の `maxSnapshotBytes`）。 */
  readonly maxBytes: number;
  /** 接続（応答の header が届くまで）の timeout。暫定。 */
  readonly connectTimeoutMs: number;
  /** 総時間（本文を読み切るまで）の timeout。暫定。 */
  readonly totalTimeoutMs: number;
  /** 呼び出し側の取消し（世代の交代・設定の無効化・profile の閉鎖・終了）。 */
  readonly signal: AbortSignal;
}

export type ModelCapabilityFetchResult =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly code: ModelCapabilityFetchFailureCode };

class FetchFailure extends Error {
  readonly failureCode: ModelCapabilityFetchFailureCode;
  constructor(code: ModelCapabilityFetchFailureCode) {
    super(code);
    this.failureCode = code;
  }
}

function statusFailure(status: number): ModelCapabilityFetchFailureCode {
  if (status >= 300 && status < 400) return "redirect";
  if (status === 429) return "http-rate-limited";
  if (status >= 500) return "http-server";
  if (status >= 400) return "http-client";
  return "http-other";
}

/**
 * 写しの本文を 1 回取得する。例外は投げず、失敗は code で返す。
 * 取消し・timeout・読込みの途中の超過では、response の body を cancel してから返す。
 */
export async function fetchModelCapabilityText(
  options: ModelCapabilityFetchOptions,
): Promise<ModelCapabilityFetchResult> {
  const { timers, signal: outer } = options;
  if (outer.aborted) return { ok: false, code: "aborted" };

  const controller = new AbortController();
  // 最初に起きた取消しの理由。closure から書き換えるので、narrowing の対象にならない object に持つ。
  const state: {
    reason: "aborted" | "timeout-connect" | "timeout-total" | null;
  } = { reason: null };
  const abortWith = (
    code: "aborted" | "timeout-connect" | "timeout-total",
  ): void => {
    if (state.reason === null) state.reason = code;
    controller.abort();
  };
  const onOuterAbort = (): void => abortWith("aborted");
  outer.addEventListener("abort", onOuterAbort, { once: true });
  const connectTimer = timers.setTimeout(
    () => abortWith("timeout-connect"),
    options.connectTimeoutMs,
  );
  const totalTimer = timers.setTimeout(
    () => abortWith("timeout-total"),
    options.totalTimeoutMs,
  );
  // abort された後に reader.read() が解決しない実装（や遅い応答）でも抜けられるようにする。
  let rejectAborted: (error: Error) => void = () => undefined;
  const abortedPromise = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  abortedPromise.catch(() => undefined);
  const onInnerAbort = (): void => {
    rejectAborted(new FetchFailure(state.reason ?? "aborted"));
  };
  controller.signal.addEventListener("abort", onInnerAbort, { once: true });

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    let response: Response;
    try {
      response = await Promise.race([
        options.fetchImpl(MODEL_CAPABILITY_FETCH_URL, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": MODEL_CAPABILITY_USER_AGENT,
            Accept: "application/json, text/plain;q=0.9",
          },
          signal: controller.signal,
        }),
        abortedPromise,
      ]);
    } catch (error) {
      if (error instanceof FetchFailure) throw error;
      throw new FetchFailure(state.reason ?? "network");
    }
    timers.clearTimeout(connectTimer);

    // 応答の header が届いた後の検査。本文は 1 byte も読まない。
    if (response.status !== 200) {
      cancelBody(response);
      throw new FetchFailure(statusFailure(response.status));
    }
    if (response.url !== MODEL_CAPABILITY_FETCH_URL) {
      cancelBody(response);
      throw new FetchFailure("url-mismatch");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const declaredBytes = Number(declared);
      if (!Number.isFinite(declaredBytes) || declaredBytes > options.maxBytes) {
        cancelBody(response);
        throw new FetchFailure("too-large");
      }
    }
    if (response.body === null) throw new FetchFailure("no-body");

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let step: Awaited<
        ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
      >;
      try {
        step = await Promise.race([reader.read(), abortedPromise]);
      } catch (error) {
        if (error instanceof FetchFailure) throw error;
        throw new FetchFailure(state.reason ?? "network");
      }
      if (step.done) break;
      total += step.value.byteLength;
      if (total > options.maxBytes) throw new FetchFailure("too-large");
      chunks.push(step.value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new FetchFailure("decode");
    }
    return { ok: true, text, bytes: total };
  } catch (error) {
    if (reader !== null) {
      // 閉じる要求を出すだけで、完了は待たない（cancel が返らない stream で scheduler を止めない）。
      reader.cancel().catch(() => undefined);
    }
    if (error instanceof FetchFailure) {
      return { ok: false, code: error.failureCode };
    }
    return { ok: false, code: "network" };
  } finally {
    timers.clearTimeout(connectTimer);
    timers.clearTimeout(totalTimer);
    outer.removeEventListener("abort", onOuterAbort);
    controller.signal.removeEventListener("abort", onInnerAbort);
  }
}

/** 閉じる要求を出すだけで、完了は待たない（cancel が返らない stream で scheduler を止めない）。 */
function cancelBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}
