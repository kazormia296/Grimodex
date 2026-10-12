/**
 * Context attributes shared by the worker and main-thread WebGL2 probes.
 * `failIfMajorPerformanceCaveat` keeps blocklisted or software-only renderers
 * on the static fallback instead of paying for a slow decorative shader.
 */
export const ZEN_WEBGL2_PROBE_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  failIfMajorPerformanceCaveat: true,
  powerPreference: "default",
  premultipliedAlpha: true,
};

/** Messages posted by `zenWebGl2Probe.worker.ts`. */
export type ZenWebGl2ProbeMessage =
  | { type: "result"; supported: boolean }
  /** The worker scope has no OffscreenCanvas; probe on the main thread. */
  | { type: "unavailable" };
