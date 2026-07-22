// @vitest-environment happy-dom
import React, { useLayoutEffect } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const motionState = vi.hoisted(() => ({
  reduced: false,
  pause: vi.fn(),
  createDrift: vi.fn(),
}));

vi.mock("@/lib/animation", () => ({
  DURATIONS: { fast: 0.15, normal: 0.2, slow: 0.3, dialog: 0.25 },
  EASINGS: { easeOut: [0.16, 1, 0.3, 1] },
  ZEN_AMBIENT_DURATIONS: {
    enter: 0.8,
    exit: 0.45,
    primaryDrift: 72,
    secondaryDrift: 88,
  },
  useReducedMotion: () => motionState.reduced,
}));

vi.mock("@/lib/gsap", () => ({
  createZenAmbientDrift: (...args: unknown[]) =>
    motionState.createDrift(...args),
}));

vi.mock("@gsap/react", () => ({
  useGSAP: (
    callback: () => void | (() => void),
    config?: { dependencies?: unknown[] },
  ) => {
    // Test-only hook shim: the real useGSAP owns dependency tracking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useLayoutEffect(callback, config?.dependencies ?? []);
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
    motionState.reduced = false;
    motionState.pause.mockReset();
    motionState.createDrift.mockReset().mockReturnValue({
      paused: motionState.pause,
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("renders exactly two non-interactive drifting lights while Zen is active", () => {
    const { container } = render(<ZenAmbientBackdrop active />);

    const backdrop = container.querySelector("[data-zen-ambient]");
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop).toHaveAttribute("data-motion", "drifting");
    expect(backdrop).toHaveAttribute("data-window-active", "true");
    expect(container.querySelectorAll("[data-zen-ambient-light]")).toHaveLength(
      2,
    );
    expect(motionState.createDrift).toHaveBeenCalledOnce();
    expect(motionState.pause).toHaveBeenLastCalledWith(false);
  });

  it("pauses drift when the window becomes inactive", () => {
    const { container } = render(<ZenAmbientBackdrop active />);

    act(() => window.dispatchEvent(new Event("blur")));

    expect(container.querySelector("[data-zen-ambient]")).toHaveAttribute(
      "data-window-active",
      "false",
    );
    expect(motionState.pause).toHaveBeenLastCalledWith(true);
  });

  it("uses a static gradient and starts no drift under Reduced Motion", () => {
    motionState.reduced = true;

    const { container } = render(<ZenAmbientBackdrop active />);

    expect(container.querySelector("[data-zen-ambient]")).toHaveAttribute(
      "data-motion",
      "static",
    );
    expect(motionState.createDrift).not.toHaveBeenCalled();
  });

  it("renders no ambient layer outside Zen", () => {
    const { container } = render(<ZenAmbientBackdrop active={false} />);

    expect(container.querySelector("[data-zen-ambient]")).toBeNull();
  });
});
