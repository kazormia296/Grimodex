import {
  ZEN_WEBGL2_PROBE_ATTRIBUTES,
  type ZenWebGl2ProbeMessage,
} from "./zenWebGl2ProbeProtocol";

/**
 * One-shot WebGL2 capability probe. Context creation can wait seconds for the
 * GPU process on slow or GPU-less hosts, so it runs here instead of on the
 * renderer main thread that owns first paint and editor input.
 */
function probe(): ZenWebGl2ProbeMessage {
  if (typeof OffscreenCanvas !== "function") return { type: "unavailable" };
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("webgl2", ZEN_WEBGL2_PROBE_ATTRIBUTES);
    if (!context) return { type: "result", supported: false };
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return { type: "result", supported: true };
  } catch {
    return { type: "result", supported: false };
  }
}

self.postMessage(probe());
self.close();
