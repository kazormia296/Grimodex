// @vitest-environment happy-dom
import React from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const zenState = vi.hoisted(() => ({
  reduced: false,
  config: {
    shader: "mesh-gradient",
    speed: 0.08,
    dither: { enabled: true },
    halftone: { enabled: true },
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

vi.mock("./zen/ZenShaderSurface", () => ({
  ZenShaderSurface: ({ playing }: { playing: boolean }) => (
    <div data-zen-shader-surface data-playing={String(playing)} />
  ),
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
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("renders the selected Paper shader and both post filters behind the Zen paper", () => {
    const { container } = render(<ZenAmbientBackdrop active />);

    const backdrop = container.querySelector("[data-zen-ambient]");
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop).toHaveAttribute("data-motion", "drifting");
    expect(backdrop).toHaveAttribute("data-window-active", "true");
    expect(backdrop).toHaveAttribute("data-zen-shader", "mesh-gradient");
    expect(backdrop).toHaveAttribute("data-zen-dither", "true");
    expect(backdrop).toHaveAttribute("data-zen-halftone", "true");
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-playing", "true");
  });

  it("stops the WebGL animation when the window becomes inactive", () => {
    const { container } = render(<ZenAmbientBackdrop active />);

    act(() => window.dispatchEvent(new Event("blur")));

    expect(container.querySelector("[data-zen-ambient]")).toHaveAttribute(
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

    expect(container.querySelector("[data-zen-ambient]")).toHaveAttribute(
      "data-motion",
      "static",
    );
    expect(
      container.querySelector("[data-zen-shader-surface]"),
    ).toHaveAttribute("data-playing", "false");
  });

  it("renders no ambient layer or WebGL canvas outside Zen", () => {
    const { container } = render(<ZenAmbientBackdrop active={false} />);

    expect(container.querySelector("[data-zen-ambient]")).toBeNull();
    expect(container.querySelector("[data-zen-shader-surface]")).toBeNull();
  });
});
