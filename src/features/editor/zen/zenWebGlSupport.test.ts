// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ZEN_WEBGL2_WORKER_PROBE_TIMEOUT_MS,
  _resetZenWebGl2SupportForTests,
  acquireZenWebGl2Probe,
  readCachedZenWebGl2Support,
  subscribeZenWebGl2Support,
} from "./zenWebGlSupport";

const gpuBlocklist = vi.hoisted(() => ({ blocked: false }));

vi.mock("@/lib/gpuFeatureStatus", () => ({
  isWebGl2GpuBlocked: () => Promise.resolve(gpuBlocklist.blocked),
}));

class FakeWorker {
  static instances: FakeWorker[] = [];
  static throwOnConstruct = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  readonly url: string;
  readonly options?: WorkerOptions;

  constructor(url: URL | string, options?: WorkerOptions) {
    if (FakeWorker.throwOnConstruct) throw new Error("blocked by CSP");
    this.url = String(url);
    this.options = options;
    FakeWorker.instances.push(this);
  }

  terminate() {
    this.terminated = true;
  }

  post(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  fail() {
    this.onerror?.(new Event("error") as ErrorEvent);
  }
}

/** Runs the double rAF + idle wait that precedes every probe. */
async function passFirstFrameAndIdle() {
  await vi.advanceTimersByTimeAsync(40);
}

function stubMainThreadContext(context: unknown) {
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as WebGL2RenderingContext);
}

describe("deferred Zen WebGL2 probe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    FakeWorker.throwOnConstruct = false;
    gpuBlocklist.blocked = false;
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) =>
      setTimeout(
        () => callback({ didTimeout: false, timeRemaining: () => 10 }),
        1,
      ),
    );
    vi.stubGlobal("cancelIdleCallback", (id: number) => clearTimeout(id));
  });

  afterEach(() => {
    _resetZenWebGl2SupportForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("never creates a context synchronously and waits for the first frame", async () => {
    const getContext = stubMainThreadContext(null);

    const release = acquireZenWebGl2Probe();

    expect(getContext).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(readCachedZenWebGl2Support()).toBeNull();

    await vi.advanceTimersByTimeAsync(16);
    expect(FakeWorker.instances).toHaveLength(0);

    await passFirstFrameAndIdle();
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].url).toContain("zenWebGl2Probe.worker");
    expect(FakeWorker.instances[0].options).toEqual({ type: "module" });
    expect(getContext).not.toHaveBeenCalled();
    release();
  });

  it("caches a supported worker result, notifies subscribers and terminates the worker", async () => {
    const listener = vi.fn();
    subscribeZenWebGl2Support(listener);
    const release = acquireZenWebGl2Probe();
    const joined = acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();

    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.instances[0].post({ type: "result", supported: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(readCachedZenWebGl2Support()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(FakeWorker.instances[0].terminated).toBe(true);

    // A later acquire reuses the per-renderer cache.
    acquireZenWebGl2Probe()();
    await passFirstFrameAndIdle();
    expect(FakeWorker.instances).toHaveLength(1);
    release();
    joined();
  });

  it("caches an unsupported worker result", async () => {
    acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();

    FakeWorker.instances[0].post({ type: "result", supported: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(readCachedZenWebGl2Support()).toBe(false);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("fails cheap to unsupported when the worker errors", async () => {
    const getContext = stubMainThreadContext({});
    acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();

    FakeWorker.instances[0].fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(readCachedZenWebGl2Support()).toBe(false);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(getContext).not.toHaveBeenCalled();
  });

  it("fails cheap to unsupported when the worker never answers", async () => {
    acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();

    await vi.advanceTimersByTimeAsync(ZEN_WEBGL2_WORKER_PROBE_TIMEOUT_MS - 50);
    expect(readCachedZenWebGl2Support()).toBeNull();

    await vi.advanceTimersByTimeAsync(50);
    expect(readCachedZenWebGl2Support()).toBe(false);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("terminates the worker and caches nothing when every holder releases", async () => {
    const listener = vi.fn();
    subscribeZenWebGl2Support(listener);
    const first = acquireZenWebGl2Probe();
    const second = acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();

    first();
    expect(FakeWorker.instances[0].terminated).toBe(false);
    second();
    expect(FakeWorker.instances[0].terminated).toBe(true);

    FakeWorker.instances[0].post({ type: "result", supported: true });
    await vi.advanceTimersByTimeAsync(ZEN_WEBGL2_WORKER_PROBE_TIMEOUT_MS);
    expect(readCachedZenWebGl2Support()).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    // A fresh holder starts a new probe.
    acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("aborts before creating a worker when released during the first-frame wait", async () => {
    acquireZenWebGl2Probe()();
    await passFirstFrameAndIdle();

    expect(FakeWorker.instances).toHaveLength(0);
    expect(readCachedZenWebGl2Support()).toBeNull();
  });

  it("probes on the main thread after paint when the worker scope lacks OffscreenCanvas", async () => {
    const loseContext = vi.fn();
    const getContext = stubMainThreadContext({
      getExtension: () => ({ loseContext }),
    });
    acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();

    FakeWorker.instances[0].post({ type: "unavailable" });
    await vi.advanceTimersByTimeAsync(0);

    expect(getContext).toHaveBeenCalledOnce();
    expect(getContext).toHaveBeenCalledWith(
      "webgl2",
      expect.objectContaining({
        antialias: false,
        failIfMajorPerformanceCaveat: true,
      }),
    );
    expect(loseContext).toHaveBeenCalledOnce();
    expect(readCachedZenWebGl2Support()).toBe(true);
  });

  it("probes on the main thread after paint when OffscreenCanvas is missing", async () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const getContext = stubMainThreadContext(null);
    acquireZenWebGl2Probe();

    expect(getContext).not.toHaveBeenCalled();
    await passFirstFrameAndIdle();

    expect(getContext).toHaveBeenCalledOnce();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(readCachedZenWebGl2Support()).toBe(false);
  });

  it("falls back to the main thread when the worker cannot be constructed, and survives a throwing probe", async () => {
    FakeWorker.throwOnConstruct = true;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => {
        throw new Error("blocked");
      },
    );
    acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();

    expect(readCachedZenWebGl2Support()).toBe(false);
  });

  it("starts the probe after a bounded wait when animation frames never run", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    acquireZenWebGl2Probe();

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWorker.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("reports unsupported without creating a Worker or context when the GPU blocklists WebGL2", async () => {
    gpuBlocklist.blocked = true;
    const getContext = stubMainThreadContext(null);
    const listener = vi.fn();
    const unsubscribe = subscribeZenWebGl2Support(listener);

    acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();

    expect(FakeWorker.instances).toHaveLength(0);
    expect(getContext).not.toHaveBeenCalled();
    expect(readCachedZenWebGl2Support()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("keeps probing with the worker when the GPU status is enabled or unknown", async () => {
    gpuBlocklist.blocked = false;
    acquireZenWebGl2Probe();
    await passFirstFrameAndIdle();

    expect(FakeWorker.instances).toHaveLength(1);
    expect(readCachedZenWebGl2Support()).toBeNull();
  });
});
