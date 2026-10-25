// @vitest-environment happy-dom
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const zenState = vi.hoisted(() => ({
  reduced: false,
  /** Cached probe result; `null` keeps the deferred probe pending. */
  webGlSupported: true as boolean | null,
  webGlProbeCalls: 0,
  webGlProbeReleases: 0,
  probeListeners: new Set<() => void>(),
  useRealProbe: false,
  rendererStatus: "webgl" as
    | "initializing"
    | "webgl"
    | "fallback-unsupported"
    | "fallback-context-lost",
  config: {
    enabled: true,
    shader: "mesh-gradient",
    speed: 8,
    dither: { enabled: true },
    halftone: { enabled: true },
    contrastGuard: { mode: "auto", strength: 1, toolMix: 0.5 },
    opacity: 80,
  },
}));

function resolveWebGlProbe(supported: boolean) {
  zenState.webGlSupported = supported;
  for (const listener of [...zenState.probeListeners]) listener();
}

vi.mock("@/lib/animation", () => ({
  EASINGS: { easeOut: [0.16, 1, 0.3, 1] },
  ZEN_AMBIENT_DURATIONS: { enter: 0.8, exit: 0.45 },
  useReducedMotion: () => zenState.reduced,
}));

vi.mock("./zen/useZenShaderConfig", () => ({
  useZenShaderConfig: () => zenState.config,
}));

vi.mock("./zen/zenThemePalette", () => ({
  useZenThemePalette: () => ({ colors: ["#101010", "#202020"] }),
}));

vi.mock("./zen/zenWebGlSupport", async (importActual) => {
  const actual = await importActual<typeof import("./zen/zenWebGlSupport")>();
  return {
    ...actual,
    readCachedZenWebGl2Support: () =>
      zenState.useRealProbe
        ? actual.readCachedZenWebGl2Support()
        : zenState.webGlSupported,
    subscribeZenWebGl2Support: (listener: () => void) => {
      if (zenState.useRealProbe) {
        return actual.subscribeZenWebGl2Support(listener);
      }
      zenState.probeListeners.add(listener);
      return () => zenState.probeListeners.delete(listener);
    },
    acquireZenWebGl2Probe: () => {
      if (zenState.useRealProbe) return actual.acquireZenWebGl2Probe();
      zenState.webGlProbeCalls += 1;
      return () => {
        zenState.webGlProbeReleases += 1;
      };
    },
  };
});

vi.mock("./zen/ZenShaderSurface", () => ({
  ZenShaderSurface: ({
    playing,
    webGlSupported,
    onRendererStatusChange,
  }: {
    playing: boolean;
    webGlSupported: boolean;
    onRendererStatusChange: (
      status:
        | "initializing"
        | "webgl"
        | "fallback-unsupported"
        | "fallback-context-lost",
    ) => void;
  }) => {
    React.useEffect(() => {
      onRendererStatusChange(
        webGlSupported ? zenState.rendererStatus : "fallback-unsupported",
      );
    }, [onRendererStatusChange, webGlSupported]);
    return (
      <div
        data-zen-shader-surface
        data-playing={String(playing)}
        data-webgl-supported={String(webGlSupported)}
      />
    );
  },
}));

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: React.forwardRef<
      HTMLDivElement,
      React.HTMLAttributes<HTMLDivElement> & {
        initial?: unknown;
        animate?: unknown;
        exit?: unknown;
        transition?: unknown;
      }
    >(function MotionDiv(
      {
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        ...props
      },
      ref,
    ) {
      return <div ref={ref} {...props} />;
    }),
  },
}));

import { ZenAmbientBackdrop } from "./ZenAmbientBackdrop";
import { _resetZenWebGl2SupportForTests } from "./zen/zenWebGlSupport";
import { useRendererReloadStore } from "@/lib/rendererReload";

describe("ZenAmbientBackdrop", () => {
  beforeEach(() => {
    zenState.reduced = false;
    zenState.webGlSupported = true;
    zenState.webGlProbeCalls = 0;
    zenState.webGlProbeReleases = 0;
    zenState.probeListeners.clear();
    zenState.useRealProbe = false;
    zenState.rendererStatus = "webgl";
    zenState.config.enabled = true;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    _resetZenWebGl2SupportForTests();
    useRendererReloadStore.setState({ gpuSurfacesReleased: false });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("removes the live WebGL surface before a renderer reload and keeps the static backdrop", () => {
    const { container } = render(<ZenAmbientBackdrop active />);
    expect(container.querySelector("[data-zen-shader-surface]")).not.toBeNull();
    expect(container.querySelector("[data-zen-static-backdrop]")).toBeNull();

    act(() => {
      useRendererReloadStore.setState({ gpuSurfacesReleased: true });
    });

    expect(container.querySelector("[data-zen-shader-surface]")).toBeNull();
    expect(container.querySelector("[data-zen-static-backdrop]")).toHaveStyle({
      opacity: "0.8",
    });
  });

  it("renders the selected Paper shader and both post filters behind the editor paper", () => {
    const { container } = render(<ZenAmbientBackdrop active />);

    const backdrop = container.querySelector("[data-editor-ambient]");
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop).toHaveAttribute("data-motion", "drifting");
    expect(backdrop).toHaveAttribute("data-window-active", "true");
    expect(backdrop).toHaveAttribute("data-background-enabled", "true");
    expect(backdrop).toHaveAttribute("data-background-renderer", "webgl");
    expect(backdrop).toHaveAttribute("data-background-shader", "mesh-gradient");
    expect(backdrop).toHaveAttribute("data-background-dither", "true");
    expect(backdrop).toHaveAttribute("data-background-halftone", "true");
    expect(backdrop).toHaveAttribute("data-background-contrast-guard", "auto");
    expect(backdrop).toHaveClass("absolute");
    expect(backdrop).not.toHaveClass("fixed");
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-playing", "true");
  });

  it("resynchronizes focus after Electron shows an initially hidden window", () => {
    vi.mocked(document.hasFocus)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    const { container } = render(<ZenAmbientBackdrop active />);

    expect(container.querySelector("[data-editor-ambient]")).toHaveAttribute(
      "data-window-active",
      "true",
    );
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-playing", "true");
  });

  it("unmounts the WebGL surface when the background is disabled", () => {
    zenState.config.enabled = false;

    const { container } = render(<ZenAmbientBackdrop active={false} />);

    expect(container.querySelector("[data-editor-ambient]")).toHaveAttribute(
      "data-background-enabled",
      "false",
    );
    expect(container.querySelector("[data-zen-shader-surface]")).toBeNull();
    expect(zenState.webGlProbeCalls).toBe(0);
  });

  it("probes once and remounts the surface when a disabled background is enabled", () => {
    zenState.webGlSupported = null;
    zenState.config.enabled = false;
    const { container, rerender } = render(
      <ZenAmbientBackdrop active={false} />,
    );

    expect(zenState.webGlProbeCalls).toBe(0);
    expect(container.querySelector("[data-zen-shader-surface]")).toBeNull();

    zenState.config.enabled = true;
    rerender(<ZenAmbientBackdrop active={false} />);

    expect(zenState.webGlProbeCalls).toBe(1);
    expect(container.querySelector("[data-zen-shader-surface]")).toBeNull();
    act(() => resolveWebGlProbe(true));
    const initializedSurface = container.querySelector(
      "[data-zen-shader-surface]",
    );
    expect(initializedSurface).toHaveAttribute("data-playing", "true");

    zenState.config.enabled = false;
    rerender(<ZenAmbientBackdrop active={false} />);

    expect(container.querySelector("[data-zen-shader-surface]")).toBeNull();

    zenState.config.enabled = true;
    rerender(<ZenAmbientBackdrop active={false} />);

    expect(zenState.webGlProbeCalls).toBe(1);
    const remountedSurface = container.querySelector(
      "[data-zen-shader-surface]",
    );
    expect(remountedSurface).not.toBe(initializedSurface);
    expect(remountedSurface).toHaveAttribute("data-playing", "true");
  });

  it("renders the static backdrop as initializing while the probe is pending, then mounts WebGL", () => {
    zenState.webGlSupported = null;

    const { container } = render(<ZenAmbientBackdrop active />);

    const backdrop = container.querySelector("[data-editor-ambient]");
    expect(zenState.webGlProbeCalls).toBe(1);
    expect(backdrop).toHaveAttribute(
      "data-background-renderer",
      "initializing",
    );
    expect(backdrop).not.toHaveAttribute("data-background-fallback-reason");
    expect(backdrop).toHaveAttribute("data-motion", "static");
    expect(container.querySelector("[data-zen-shader-surface]")).toBeNull();
    expect(container.querySelector("[data-zen-static-backdrop]")).toHaveStyle({
      opacity: "0.8",
    });

    act(() => resolveWebGlProbe(true));

    expect(backdrop).toHaveAttribute("data-background-renderer", "webgl");
    expect(backdrop).toHaveAttribute("data-motion", "drifting");
    expect(container.querySelector("[data-zen-static-backdrop]")).toBeNull();
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-webgl-supported", "true");
  });

  it("settles a pending probe on the static fallback when WebGL2 is unsupported", () => {
    zenState.webGlSupported = null;

    const { container } = render(<ZenAmbientBackdrop active />);
    act(() => resolveWebGlProbe(false));

    const backdrop = container.querySelector("[data-editor-ambient]");
    expect(backdrop).toHaveAttribute("data-background-renderer", "fallback");
    expect(backdrop).toHaveAttribute(
      "data-background-fallback-reason",
      "fallback-unsupported",
    );
    expect(backdrop).toHaveAttribute("data-motion", "static");
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-webgl-supported", "false");
  });

  it("releases a pending probe on unmount without later updates", () => {
    zenState.webGlSupported = null;
    const consoleError = vi.spyOn(console, "error");

    const { unmount } = render(<ZenAmbientBackdrop active />);
    expect(zenState.webGlProbeCalls).toBe(1);
    unmount();

    expect(zenState.webGlProbeReleases).toBe(1);
    expect(zenState.probeListeners.size).toBe(0);
    act(() => resolveWebGlProbe(true));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps Reduced Motion static after a deferred probe resolves", () => {
    zenState.reduced = true;
    zenState.webGlSupported = null;

    const { container } = render(<ZenAmbientBackdrop active />);
    act(() => resolveWebGlProbe(true));

    expect(container.querySelector("[data-editor-ambient]")).toHaveAttribute(
      "data-motion",
      "static",
    );
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-playing", "false");
  });

  it("never creates a WebGL context during render and probes in a worker after the first frame", async () => {
    zenState.useRealProbe = true;
    vi.useFakeTimers();
    const workers: Array<{
      onmessage: ((event: MessageEvent) => void) | null;
      terminated: boolean;
    }> = [];
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror = null;
        onmessageerror = null;
        terminated = false;
        constructor() {
          workers.push(this);
        }
        terminate() {
          this.terminated = true;
        }
      },
    );
    vi.stubGlobal("OffscreenCanvas", class {});
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");

    const { container } = render(<ZenAmbientBackdrop active />);

    expect(getContext).not.toHaveBeenCalled();
    expect(workers).toHaveLength(0);
    expect(container.querySelector("[data-editor-ambient]")).toHaveAttribute(
      "data-background-renderer",
      "initializing",
    );

    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(workers).toHaveLength(1);
    await act(async () => {
      workers[0].onmessage?.({
        data: { type: "result", supported: true },
      } as MessageEvent);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(getContext).not.toHaveBeenCalled();
    expect(workers[0].terminated).toBe(true);
    expect(container.querySelector("[data-editor-ambient]")).toHaveAttribute(
      "data-background-renderer",
      "webgl",
    );
  });

  it("keeps a static background without mounting WebGL work when WebGL2 is unavailable", () => {
    zenState.webGlSupported = false;

    const { container } = render(<ZenAmbientBackdrop active />);

    const backdrop = container.querySelector("[data-editor-ambient]");
    expect(backdrop).toHaveAttribute("data-background-enabled", "true");
    expect(backdrop).toHaveAttribute("data-background-renderer", "fallback");
    expect(backdrop).toHaveAttribute(
      "data-background-fallback-reason",
      "fallback-unsupported",
    );
    expect(backdrop).toHaveAttribute("data-motion", "static");
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-webgl-supported", "false");
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-playing", "false");
  });

  it("keeps initializing distinct from a real WebGL fallback", () => {
    zenState.rendererStatus = "initializing";

    const { container } = render(<ZenAmbientBackdrop active />);

    const backdrop = container.querySelector("[data-editor-ambient]");
    expect(backdrop).toHaveAttribute(
      "data-background-renderer",
      "initializing",
    );
    expect(backdrop).not.toHaveAttribute("data-background-fallback-reason");
    expect(backdrop).toHaveAttribute("data-motion", "static");
  });

  it("stops the WebGL animation when the window becomes inactive", () => {
    const { container } = render(<ZenAmbientBackdrop active />);

    act(() => window.dispatchEvent(new Event("blur")));

    expect(container.querySelector("[data-editor-ambient]")).toHaveAttribute(
      "data-window-active",
      "false",
    );
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-playing", "false");
  });

  it("renders a static shader frame under Reduced Motion", () => {
    zenState.reduced = true;

    const { container } = render(<ZenAmbientBackdrop active />);

    expect(container.querySelector("[data-editor-ambient]")).toHaveAttribute(
      "data-motion",
      "static",
    );
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-playing", "false");
  });

  it("keeps the ambient layer and WebGL canvas active outside Zen", () => {
    const { container } = render(<ZenAmbientBackdrop active={false} />);

    expect(container.querySelector("[data-editor-ambient]")).toHaveAttribute(
      "data-zen-mode",
      "false",
    );
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-playing", "true");
  });
});
