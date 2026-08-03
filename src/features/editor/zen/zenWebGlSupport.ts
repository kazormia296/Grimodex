let cachedWebGl2Support: boolean | null = null;

/**
 * Paper Shaders requires WebGL2. Probe once before mounting its asynchronous
 * React wrapper so a blocklisted or software-only renderer can take the cheap
 * static fallback without producing an unhandled initialization rejection.
 */
export function hasUsableZenWebGl2(): boolean {
  if (cachedWebGl2Support !== null) return cachedWebGl2Support;
  if (typeof document === "undefined") {
    cachedWebGl2Support = false;
    return cachedWebGl2Support;
  }

  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      failIfMajorPerformanceCaveat: true,
      powerPreference: "default",
      premultipliedAlpha: true,
    });
    cachedWebGl2Support = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
  } catch {
    cachedWebGl2Support = false;
  }
  return cachedWebGl2Support;
}

export function _resetZenWebGl2SupportForTests(): void {
  cachedWebGl2Support = null;
}
