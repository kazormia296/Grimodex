import { isWebGl2GpuBlocked } from "@/lib/gpuFeatureStatus";
import {
  ZEN_WEBGL2_PROBE_ATTRIBUTES,
  type ZenWebGl2ProbeMessage,
} from "./zenWebGl2ProbeProtocol";

/** Upper bounds for the post-paint waits before the probe starts. */
const PROBE_START_FRAME_TIMEOUT_MS = 1_000;
const PROBE_START_IDLE_TIMEOUT_MS = 1_000;
/**
 * A blocklisted GPU can hold context creation for many seconds. The backdrop is
 * decorative, so a slow answer is treated as "unsupported" (static fallback).
 */
export const ZEN_WEBGL2_WORKER_PROBE_TIMEOUT_MS = 5_000;

interface InFlightProbe {
  controller: AbortController;
  leases: number;
}

let cachedWebGl2Support: boolean | null = null;
let inFlightProbe: InFlightProbe | null = null;
const listeners = new Set<() => void>();

/**
 * Last resolved WebGL2 probe result for this renderer, or `null` while it is
 * unknown. This only reads the cache and never creates a context, so render
 * paths may call it freely.
 */
export function readCachedZenWebGl2Support(): boolean | null {
  return cachedWebGl2Support;
}

export function subscribeZenWebGl2Support(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Starts (or joins) the single per-renderer WebGL2 probe and returns a release
 * function. Paper Shaders requires WebGL2; probing before mounting its wrapper
 * lets blocklisted or software-only renderers take the cheap static fallback
 * without an unhandled initialization rejection. The probe waits for the first
 * frame and an idle slot, then runs in a Worker on an OffscreenCanvas so
 * context creation never blocks first paint. When every holder releases before
 * the result arrives, the probe is aborted (worker terminated) and nothing is
 * cached, so a later acquire probes again.
 */
export function acquireZenWebGl2Probe(): () => void {
  if (cachedWebGl2Support !== null) return () => {};

  let flight = inFlightProbe;
  if (!flight) {
    const started: InFlightProbe = {
      controller: new AbortController(),
      leases: 0,
    };
    flight = started;
    inFlightProbe = started;
    void runProbe(started.controller.signal).then((supported) => {
      if (inFlightProbe !== started || started.controller.signal.aborted) {
        return;
      }
      inFlightProbe = null;
      cachedWebGl2Support = supported;
      for (const listener of [...listeners]) listener();
    });
  }

  const held = flight;
  held.leases += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.leases -= 1;
    if (held.leases === 0 && inFlightProbe === held) {
      inFlightProbe = null;
      held.controller.abort();
    }
  };
}

async function runProbe(signal: AbortSignal): Promise<boolean> {
  if (typeof document === "undefined") return false;
  // A GPU blocklist that already rules out WebGL2 is decided by main, so skip
  // the Worker and the context creation that would only wait for GPU refusal.
  if (await isWebGl2GpuBlocked()) return false;
  if (signal.aborted) return false;
  await waitForFirstFrame(signal);
  await waitForIdle(signal);
  if (signal.aborted) return false;

  const workerResult = await probeInWorker(signal);
  if (workerResult !== "unavailable") return workerResult;
  if (signal.aborted) return false;
  return probeOnMainThread();
}

/**
 * Resolves after a double rAF, i.e. once the first frame has been committed.
 * Hidden windows do not run animation frames, so the wait is bounded.
 */
function waitForFirstFrame(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let frameId: number | null = null;
    const finish = () => {
      if (frameId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameId);
      }
      frameId = null;
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeoutId = setTimeout(finish, PROBE_START_FRAME_TIMEOUT_MS);
    signal.addEventListener("abort", finish, { once: true });
    if (typeof requestAnimationFrame === "function") {
      frameId = requestAnimationFrame(() => {
        frameId = requestAnimationFrame(finish);
      });
    }
  });
}

/** Yields to hydration work; bounded so a busy renderer still probes. */
function waitForIdle(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const useIdle = typeof requestIdleCallback === "function";
    const finish = () => {
      if (useIdle) cancelIdleCallback(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const handle: number | ReturnType<typeof setTimeout> = useIdle
      ? requestIdleCallback(finish, { timeout: PROBE_START_IDLE_TIMEOUT_MS })
      : setTimeout(finish, 0);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function probeInWorker(signal: AbortSignal): Promise<boolean | "unavailable"> {
  if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function") {
    return Promise.resolve("unavailable");
  }

  let worker: Worker;
  try {
    worker = new Worker(
      new URL("./zenWebGl2Probe.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return Promise.resolve("unavailable");
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean | "unavailable") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      resolve(result);
    };
    const abort = () => finish(false);
    const timeoutId = setTimeout(
      () => finish(false),
      ZEN_WEBGL2_WORKER_PROBE_TIMEOUT_MS,
    );

    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<ZenWebGl2ProbeMessage>) => {
      const message = event.data;
      if (message?.type === "unavailable") finish("unavailable");
      else finish(message?.type === "result" && message.supported === true);
    };
    // A worker that cannot load or crashes fails cheap: static fallback.
    worker.onerror = (event) => {
      event.preventDefault();
      finish(false);
    };
    worker.onmessageerror = () => finish(false);
  });
}

/** Fallback when Worker/OffscreenCanvas is unavailable; runs post-paint only. */
function probeOnMainThread(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", ZEN_WEBGL2_PROBE_ATTRIBUTES);
    const supported = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
    return supported;
  } catch {
    return false;
  }
}

export function _resetZenWebGl2SupportForTests(): void {
  inFlightProbe?.controller.abort();
  inFlightProbe = null;
  cachedWebGl2Support = null;
  listeners.clear();
}
