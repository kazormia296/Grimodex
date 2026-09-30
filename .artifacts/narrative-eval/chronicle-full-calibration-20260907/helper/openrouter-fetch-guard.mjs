import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export const OPENROUTER_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODEL = "openai/gpt-5.6-luna";
export const FETCH_GUARD_STATE = Symbol.for(
  "grimodex.chronicle-llm-judge-live.fetch-guard.v1",
);

export const MAX_REQUESTS = 18;
export const MAX_RESPONSE_BYTES = 2_000_000;
export const MAX_RUNTIME_MS = 300_000;
export const MAX_INPUT_TOKENS = 65_536;
export const MAX_OUTPUT_TOKENS = 32_768;
export const MAX_BUDGET_USD = 3;
export const PROMPT_PRICE_USD_PER_MILLION = 0.25;
export const COMPLETION_PRICE_USD_PER_MILLION = 1.5;
export const INPUT_SAFETY_TOKENS = 1_024;

const PROGRESS_SCHEMA_VERSION = 1;
const ACTIVE_HANDLES = new WeakMap();
const PROGRESS_STATUSES = new Set([
  "ready",
  "request-rejected",
  "request-budget-exceeded",
  "request-body-invalid",
  "request-input-limit-exceeded",
  "request-budget-overflow",
  "request-started",
  "transport-failure",
  "request-aborted",
  "request-timeout",
  "response-too-large",
  "response-read-failure",
  "invalid-http-status",
  "http-failure",
  "response-accepted",
]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function finiteStatus(value) {
  return Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function parseContentLength(response) {
  let value;
  try {
    value = response?.headers?.get?.("content-length");
  } catch {
    return "invalid";
  }
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : "invalid";
}

function cancelBody(body) {
  try {
    const result = body?.cancel?.();
    if (result && typeof result.catch === "function")
      void result.catch(() => {});
  } catch {
    // Body cancellation is best effort and never exposes provider details.
  }
}

function cancelReader(reader) {
  try {
    const result = reader?.cancel?.();
    if (result && typeof result.catch === "function")
      void result.catch(() => {});
  } catch {
    // Reader cancellation is best effort and never exposes provider details.
  }
}

function normalizeReadFailure(error, deadline) {
  if (error?.code === "LIVE_JUDGE_FETCH_TIMEOUT") return error;
  if (error?.code === "LIVE_JUDGE_REQUEST_ABORTED") return error;
  if (deadline.timedOut) return fixedError("LIVE_JUDGE_FETCH_TIMEOUT");
  if (deadline.callerAborted) return fixedError("LIVE_JUDGE_REQUEST_ABORTED");
  return fixedError("LIVE_JUDGE_RESPONSE_READ_FAILURE");
}

function createDeadline(maxRuntimeMs, callerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let timer;
  let rejectTimeout;
  let rejectAbort;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(fixedError("LIVE_JUDGE_FETCH_TIMEOUT"));
    }, maxRuntimeMs);
  });
  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    if (callerAborted || timedOut) return;
    callerAborted = true;
    controller.abort();
    rejectAbort(fixedError("LIVE_JUDGE_REQUEST_ABORTED"));
  };
  if (callerSignal?.aborted) {
    onAbort();
  } else if (typeof callerSignal?.addEventListener === "function") {
    callerSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timeoutPromise,
    abortPromise,
    get timedOut() {
      return timedOut;
    },
    get callerAborted() {
      return callerAborted;
    },
    finish() {
      clearTimeout(timer);
      if (typeof callerSignal?.removeEventListener === "function") {
        callerSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function raceDeadline(operation, deadline) {
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      deadline.timeoutPromise,
      deadline.abortPromise,
    ]);
  } catch (error) {
    if (deadline.timedOut) throw fixedError("LIVE_JUDGE_FETCH_TIMEOUT");
    if (deadline.callerAborted) {
      throw fixedError("LIVE_JUDGE_REQUEST_ABORTED");
    }
    throw error;
  }
}

async function readBodyBounded(response, maxBytes, deadline) {
  const declared = parseContentLength(response);
  if (declared === "invalid" || (declared !== null && declared > maxBytes)) {
    cancelBody(response?.body);
    throw fixedError("LIVE_JUDGE_RESPONSE_TOO_LARGE");
  }

  if (!response?.body?.getReader) {
    try {
      const text = await raceDeadline(() => response?.text?.() ?? "", deadline);
      const bytes = Buffer.from(text, "utf8");
      if (bytes.byteLength > maxBytes) {
        throw fixedError("LIVE_JUDGE_RESPONSE_TOO_LARGE");
      }
      return bytes;
    } catch (error) {
      if (error?.code === "LIVE_JUDGE_RESPONSE_TOO_LARGE") throw error;
      throw normalizeReadFailure(error, deadline);
    }
  }

  let reader;
  try {
    reader = response.body.getReader();
  } catch {
    throw fixedError("LIVE_JUDGE_RESPONSE_READ_FAILURE");
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      let part;
      try {
        part = await raceDeadline(() => reader.read(), deadline);
      } catch (error) {
        cancelReader(reader);
        throw normalizeReadFailure(error, deadline);
      }
      if (part?.done) break;
      const value = part?.value;
      if (!(value instanceof Uint8Array)) {
        cancelReader(reader);
        throw fixedError("LIVE_JUDGE_RESPONSE_READ_FAILURE");
      }
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        cancelReader(reader);
        throw fixedError("LIVE_JUDGE_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Nothing to release for an already closed reader.
    }
  }
}

function limitOption(options, name, fallback, maximum) {
  const value = options[name] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw fixedError("LIVE_JUDGE_LIMIT_INVALID");
  }
  if (name !== "maxRequests" && value === 0) {
    throw fixedError("LIVE_JUDGE_LIMIT_INVALID");
  }
  return value;
}

function resolveOptions(options) {
  if (!isRecord(options)) throw fixedError("LIVE_JUDGE_LIMIT_INVALID");
  const budgetValue =
    options.budgetUsd ?? options.maxBudgetUsd ?? MAX_BUDGET_USD;
  if (
    typeof budgetValue !== "number" ||
    !Number.isFinite(budgetValue) ||
    budgetValue < 0 ||
    budgetValue > MAX_BUDGET_USD
  ) {
    throw fixedError("LIVE_JUDGE_LIMIT_INVALID");
  }
  if (
    options.budgetUsd !== undefined &&
    options.maxBudgetUsd !== undefined &&
    options.budgetUsd !== options.maxBudgetUsd
  ) {
    throw fixedError("LIVE_JUDGE_LIMIT_INVALID");
  }
  const progressPath = options.progressPath;
  if (progressPath !== undefined && typeof progressPath !== "string") {
    throw fixedError("LIVE_JUDGE_LIMIT_INVALID");
  }
  return {
    maxRequests: limitOption(
      options,
      "maxRequests",
      MAX_REQUESTS,
      MAX_REQUESTS,
    ),
    maxResponseBytes: limitOption(
      options,
      "maxResponseBytes",
      MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    ),
    maxRuntimeMs: limitOption(
      options,
      "maxRuntimeMs",
      MAX_RUNTIME_MS,
      MAX_RUNTIME_MS,
    ),
    maxInputTokens: limitOption(
      options,
      "maxInputTokens",
      MAX_INPUT_TOKENS,
      MAX_INPUT_TOKENS,
    ),
    maxOutputTokens: limitOption(
      options,
      "maxOutputTokens",
      MAX_OUTPUT_TOKENS,
      MAX_OUTPUT_TOKENS,
    ),
    budgetUsd: budgetValue,
    progressPath,
  };
}

function openOwnedProgress(progressPath) {
  if (progressPath === undefined) return undefined;
  if (progressPath.length === 0) {
    throw fixedError("LIVE_JUDGE_PROGRESS_CREATE_FAILED");
  }
  let parent;
  try {
    parent = lstatSync(dirname(progressPath));
    if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) {
      throw new Error("progress parent is not an owned scratch directory");
    }
    if (
      typeof process.getuid === "function" &&
      parent.uid !== process.getuid()
    ) {
      throw new Error("progress parent ownership is invalid");
    }
  } catch {
    throw fixedError("LIVE_JUDGE_PROGRESS_CREATE_FAILED");
  }
  let descriptor;
  try {
    descriptor = openSync(progressPath, "wx", 0o600);
    const file = fstatSync(descriptor);
    if (!file.isFile() || (file.mode & 0o777) !== 0o600) {
      throw new Error("progress file mode is invalid");
    }
    return descriptor;
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The fixed installation error is the only persisted outcome.
      }
    }
    throw fixedError("LIVE_JUDGE_PROGRESS_CREATE_FAILED");
  }
}

function writeProgress(descriptor, state, status) {
  if (descriptor === undefined || !PROGRESS_STATUSES.has(status)) return;
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: PROGRESS_SCHEMA_VERSION,
      status,
      admittedRequests: state.admittedRequests,
      maxRequests: state.maxRequests,
      httpStatus: finiteStatus(state.lastHttpStatus),
    }) + "\n",
    "utf8",
  );
  try {
    ftruncateSync(descriptor, 0);
    let offset = 0;
    while (offset < payload.byteLength) {
      const written = writeSync(
        descriptor,
        payload,
        offset,
        payload.byteLength - offset,
        offset,
      );
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error("progress write was incomplete");
      }
      offset += written;
    }
    fsyncSync(descriptor);
  } catch {
    state.progressWriteFailed = true;
    throw fixedError("LIVE_JUDGE_PROGRESS_WRITE_FAILED");
  }
}

function validProvider(provider) {
  return (
    isRecord(provider) &&
    Array.isArray(provider.only) &&
    provider.only.length === 1 &&
    provider.only[0] === "openai" &&
    provider.allow_fallbacks === false &&
    provider.require_parameters === true &&
    isRecord(provider.max_price) &&
    provider.max_price.prompt === PROMPT_PRICE_USD_PER_MILLION &&
    provider.max_price.completion === COMPLETION_PRICE_USD_PER_MILLION
  );
}

function validateRequestBody(body, options) {
  if (typeof body !== "string")
    throw fixedError("LIVE_JUDGE_REQUEST_BODY_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw fixedError("LIVE_JUDGE_REQUEST_BODY_INVALID");
  }
  if (
    !isRecord(parsed) ||
    parsed.model !== OPENROUTER_MODEL ||
    !isRecord(parsed.reasoning) ||
    parsed.reasoning.effort !== "max" ||
    !validProvider(parsed.provider) ||
    !Number.isSafeInteger(parsed.max_tokens) ||
    parsed.max_tokens < 1 ||
    parsed.max_tokens > options.maxOutputTokens
  ) {
    throw fixedError("LIVE_JUDGE_REQUEST_BODY_INVALID");
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const reservedInputTokens = bodyBytes + INPUT_SAFETY_TOKENS;
  if (
    !Number.isSafeInteger(reservedInputTokens) ||
    reservedInputTokens < 1 ||
    reservedInputTokens > options.maxInputTokens
  ) {
    throw fixedError("LIVE_JUDGE_INPUT_LIMIT_EXCEEDED");
  }
  const reservedOutputTokens = parsed.max_tokens;
  const reservedCostUsd =
    (reservedInputTokens * PROMPT_PRICE_USD_PER_MILLION) / 1_000_000 +
    (reservedOutputTokens * COMPLETION_PRICE_USD_PER_MILLION) / 1_000_000;
  if (!Number.isFinite(reservedCostUsd) || reservedCostUsd < 0) {
    throw fixedError("LIVE_JUDGE_BUDGET_OVERFLOW");
  }
  return { reservedInputTokens, reservedOutputTokens, reservedCostUsd };
}

function blocked(state, descriptor, status, code) {
  state.blockedRequests += 1;
  writeProgress(descriptor, state, status);
  throw fixedError(code);
}

/**
 * Install the only network boundary used by the Luna max live helper. Every
 * request is checked before the underlying fetch and every response is bounded
 * before it is returned to the caller. The returned restore function is
 * test-only and closes the owned progress descriptor.
 */
export function installOpenRouterFetchGuard(options = {}) {
  const resolved = resolveOptions(options);
  const existing = globalThis[FETCH_GUARD_STATE];
  if (existing?.installed) {
    const existingHandle = ACTIVE_HANDLES.get(existing);
    if (existingHandle) return existingHandle;
    throw fixedError("LIVE_JUDGE_FETCH_ALREADY_GUARDED");
  }
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    throw fixedError("LIVE_JUDGE_FETCH_UNAVAILABLE");
  }
  const progressDescriptor = openOwnedProgress(resolved.progressPath);
  const calls = [];
  const state = {
    schemaVersion: 1,
    endpoint: OPENROUTER_ENDPOINT,
    model: OPENROUTER_MODEL,
    reasoningEffort: "max",
    maxRequests: resolved.maxRequests,
    maxResponseBytes: resolved.maxResponseBytes,
    maxRuntimeMs: resolved.maxRuntimeMs,
    maxInputTokens: resolved.maxInputTokens,
    maxOutputTokens: resolved.maxOutputTokens,
    budgetUsd: resolved.budgetUsd,
    promptPriceUsdPerMillion: PROMPT_PRICE_USD_PER_MILLION,
    completionPriceUsdPerMillion: COMPLETION_PRICE_USD_PER_MILLION,
    admittedRequests: 0,
    blockedRequests: 0,
    lastHttpStatus: null,
    reservedCostUsd: 0,
    progressWriteFailed: false,
    calls,
    installed: true,
  };
  globalThis[FETCH_GUARD_STATE] = state;
  try {
    writeProgress(progressDescriptor, state, "ready");
  } catch (error) {
    if (globalThis[FETCH_GUARD_STATE] === state) {
      delete globalThis[FETCH_GUARD_STATE];
    }
    if (progressDescriptor !== undefined) {
      try {
        closeSync(progressDescriptor);
      } catch {
        // The fixed progress-write error is the only persisted outcome.
      }
    }
    throw error;
  }

  const guardedFetch = async (input, init) => {
    if (state.progressWriteFailed) {
      state.blockedRequests += 1;
      throw fixedError("LIVE_JUDGE_PROGRESS_WRITE_FAILED");
    }
    let url;
    try {
      const rawUrl =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input?.url;
      url = new URL(rawUrl);
    } catch {
      return blocked(
        state,
        progressDescriptor,
        "request-rejected",
        "LIVE_JUDGE_UNEXPECTED_OPENROUTER_REQUEST",
      );
    }
    const method = String(
      init?.method ?? (typeof input === "object" ? input?.method : "GET"),
    ).toUpperCase();
    const redirect = init?.redirect;
    if (
      url.href !== OPENROUTER_ENDPOINT ||
      method !== "POST" ||
      redirect !== "error"
    ) {
      return blocked(
        state,
        progressDescriptor,
        "request-rejected",
        "LIVE_JUDGE_UNEXPECTED_OPENROUTER_REQUEST",
      );
    }

    let headers;
    try {
      headers = new Headers(init?.headers);
    } catch {
      return blocked(
        state,
        progressDescriptor,
        "request-rejected",
        "LIVE_JUDGE_REQUEST_BODY_INVALID",
      );
    }
    const contentType = headers.get("content-type");
    if (contentType !== null && contentType !== "application/json") {
      return blocked(
        state,
        progressDescriptor,
        "request-rejected",
        "LIVE_JUDGE_REQUEST_BODY_INVALID",
      );
    }
    headers.set("content-type", "application/json");

    let reservation;
    try {
      reservation = validateRequestBody(init?.body, resolved);
    } catch (error) {
      const code =
        error?.code === "LIVE_JUDGE_INPUT_LIMIT_EXCEEDED"
          ? "LIVE_JUDGE_INPUT_LIMIT_EXCEEDED"
          : "LIVE_JUDGE_REQUEST_BODY_INVALID";
      const status =
        code === "LIVE_JUDGE_INPUT_LIMIT_EXCEEDED"
          ? "request-input-limit-exceeded"
          : "request-body-invalid";
      return blocked(state, progressDescriptor, status, code);
    }

    if (state.admittedRequests >= resolved.maxRequests) {
      return blocked(
        state,
        progressDescriptor,
        "request-budget-exceeded",
        "LIVE_JUDGE_REQUEST_BUDGET_EXHAUSTED",
      );
    }
    if (
      !Number.isFinite(state.reservedCostUsd) ||
      state.reservedCostUsd + reservation.reservedCostUsd > resolved.budgetUsd
    ) {
      return blocked(
        state,
        progressDescriptor,
        "request-budget-overflow",
        "LIVE_JUDGE_BUDGET_EXCEEDED",
      );
    }

    state.admittedRequests += 1;
    state.reservedCostUsd += reservation.reservedCostUsd;
    const invocationIndex = state.admittedRequests;
    calls.push({ invocationIndex, requestDigest: digest(init.body) });
    state.lastHttpStatus = null;
    writeProgress(progressDescriptor, state, "request-started");

    const deadline = createDeadline(resolved.maxRuntimeMs, init?.signal);
    let response;
    try {
      response = await raceDeadline(
        () =>
          originalFetch(input, {
            ...init,
            method: "POST",
            redirect: "error",
            headers,
            body: init.body,
            signal: deadline.signal,
          }),
        deadline,
      );
    } catch (error) {
      deadline.finish();
      if (error?.code === "LIVE_JUDGE_FETCH_TIMEOUT") {
        writeProgress(progressDescriptor, state, "request-timeout");
        throw error;
      }
      if (error?.code === "LIVE_JUDGE_REQUEST_ABORTED") {
        writeProgress(progressDescriptor, state, "request-aborted");
        throw error;
      }
      writeProgress(progressDescriptor, state, "transport-failure");
      throw fixedError("LIVE_JUDGE_FETCH_REJECTED");
    }

    state.lastHttpStatus = finiteStatus(response?.status);
    let bodyBytes;
    try {
      bodyBytes = await readBodyBounded(
        response,
        resolved.maxResponseBytes,
        deadline,
      );
    } catch (error) {
      deadline.finish();
      if (error?.code === "LIVE_JUDGE_RESPONSE_TOO_LARGE") {
        writeProgress(progressDescriptor, state, "response-too-large");
        throw error;
      }
      if (error?.code === "LIVE_JUDGE_FETCH_TIMEOUT") {
        writeProgress(progressDescriptor, state, "request-timeout");
        throw error;
      }
      if (error?.code === "LIVE_JUDGE_REQUEST_ABORTED") {
        writeProgress(progressDescriptor, state, "request-aborted");
        throw error;
      }
      writeProgress(progressDescriptor, state, "response-read-failure");
      throw fixedError("LIVE_JUDGE_RESPONSE_READ_FAILURE");
    }
    deadline.finish();

    if (state.lastHttpStatus === null) {
      writeProgress(progressDescriptor, state, "invalid-http-status");
      throw fixedError("LIVE_JUDGE_INVALID_HTTP_STATUS");
    }
    if (state.lastHttpStatus < 200 || state.lastHttpStatus >= 300) {
      writeProgress(progressDescriptor, state, "http-failure");
      throw fixedError("LIVE_JUDGE_HTTP_FAILURE");
    }
    writeProgress(progressDescriptor, state, "response-accepted");
    try {
      return new Response(bodyBytes, {
        status: state.lastHttpStatus,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      throw fixedError("LIVE_JUDGE_RESPONSE_INVALID");
    }
  };

  let restored = false;
  const handle = {
    state,
    restore() {
      if (restored) return;
      restored = true;
      if (globalThis.fetch === guardedFetch) globalThis.fetch = originalFetch;
      if (globalThis[FETCH_GUARD_STATE] === state) {
        delete globalThis[FETCH_GUARD_STATE];
      }
      ACTIVE_HANDLES.delete(state);
      if (progressDescriptor !== undefined) {
        try {
          closeSync(progressDescriptor);
        } catch {
          // Restore remains idempotent even if the descriptor was already closed.
        }
      }
    },
  };
  ACTIVE_HANDLES.set(state, handle);
  globalThis.fetch = guardedFetch;
  return handle;
}

export function currentGuardHttpStatus() {
  return finiteStatus(globalThis[FETCH_GUARD_STATE]?.lastHttpStatus);
}
