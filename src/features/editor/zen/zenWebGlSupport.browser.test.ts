import { afterEach, describe, expect, it, vi } from "vitest";
import { ZEN_WEBGL2_PROBE_ATTRIBUTES } from "./zenWebGl2ProbeProtocol";
import {
  _resetZenWebGl2SupportForTests,
  acquireZenWebGl2Probe,
  readCachedZenWebGl2Support,
  subscribeZenWebGl2Support,
} from "./zenWebGlSupport";

function probeMainThread() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2", ZEN_WEBGL2_PROBE_ATTRIBUTES);
  context?.getExtension("WEBGL_lose_context")?.loseContext();
  return context !== null;
}

describe("deferred Zen WebGL2 probe in Chromium", () => {
  afterEach(() => {
    _resetZenWebGl2SupportForTests();
    vi.restoreAllMocks();
  });

  it("loads the bundled worker and agrees with a main-thread probe", async () => {
    const NativeWorker = window.Worker;
    const workerUrls: string[] = [];
    vi.stubGlobal(
      "Worker",
      class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          workerUrls.push(String(url));
        }
      },
    );

    const started = performance.now();
    const supported = await new Promise<boolean>((resolve) => {
      const unsubscribe = subscribeZenWebGl2Support(() => {
        unsubscribe();
        resolve(readCachedZenWebGl2Support() === true);
      });
      acquireZenWebGl2Probe();
    });
    vi.unstubAllGlobals();

    expect(workerUrls).toHaveLength(1);
    expect(workerUrls[0]).toContain("zenWebGl2Probe.worker");
    // Under the suite's SwiftShader flags `failIfMajorPerformanceCaveat`
    // behaves the same in the worker as on the main thread.
    expect(supported).toBe(probeMainThread());
    expect(supported).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
