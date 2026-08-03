// @vitest-environment happy-dom
import React from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const zenState = vi.hoisted(() => ({
  reduced: false,
  webGlSupported: true,
  webGlProbeCalls: 0,
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
  },
}));

vi.mock("@/lib/animation", () => ({
  EASINGS: { easeOut: [0.16, 1, 0.3, 1] },
  ZEN_AMBIENT_DURATIONS: { enter: 0.8, exit: 0.45 },
  useReducedMotion: () => zenState.reduced,
}));

vi.mock("./zen/useZenShaderConfig", () => ({
  useZenShaderConfig: () => zenState.config,
}));

vi.mock("./zen/zenWebGlSupport", () => ({
  hasUsableZenWebGl2: () => {
    zenState.webGlProbeCalls += 1;
    return zenState.webGlSupported;
  },
}));

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

describe("ZenAmbientBackdrop", () => {
  beforeEach(() => {
    zenState.reduced = false;
    zenState.webGlSupported = true;
    zenState.webGlProbeCalls = 0;
    zenState.rendererStatus = "webgl";
    zenState.config.enabled = true;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
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

  it("probes once when a disabled background is enabled later", () => {
    zenState.config.enabled = false;
    const { container, rerender } = render(
      <ZenAmbientBackdrop active={false} />,
    );

    expect(zenState.webGlProbeCalls).toBe(0);
    expect(container.querySelector("[data-zen-shader-surface]")).toBeNull();

    zenState.config.enabled = true;
    rerender(<ZenAmbientBackdrop active={false} />);

    expect(zenState.webGlProbeCalls).toBe(1);
    expect(container.querySelector("[data-zen-shader-surface]")).not.toBeNull();
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
