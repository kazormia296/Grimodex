// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  return {
    motion: {
      div: forwardRef(
        (
          { children, ...props }: React.HTMLAttributes<HTMLDivElement>,
          ref: React.Ref<HTMLDivElement>,
        ) => createElement("div", { ...props, ref }, children),
      ),
    },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      children ?? null,
  };
});

vi.mock("@/lib/animation", () => ({
  useReducedMotion: () => false,
  DURATIONS: { fast: 0.15, normal: 0.2, slow: 0.3, dialog: 0.25 },
  EASINGS: { easeOut: [0, 0, 0, 0], spring: { type: "spring" } },
}));

import { AnimatedOverlay } from "./animated-overlay";

describe("AnimatedOverlay", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
  });

  it("renders children when open", () => {
    render(
      <AnimatedOverlay open onClose={onClose} className="dialog">
        <span>Content</span>
      </AnimatedOverlay>,
    );
    expect(screen.getByText("Content")).toBeTruthy();
  });

  it("does not render children when closed", () => {
    render(
      <AnimatedOverlay open={false} onClose={onClose} className="dialog">
        <span>Content</span>
      </AnimatedOverlay>,
    );
    expect(screen.queryByText("Content")).toBeNull();
  });

  it("calls onClose when Escape is pressed", async () => {
    render(
      <AnimatedOverlay open onClose={onClose} className="dialog">
        <span>Content</span>
      </AnimatedOverlay>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClose from Escape when closed", async () => {
    render(
      <AnimatedOverlay open={false} onClose={onClose} className="dialog">
        <span>Content</span>
      </AnimatedOverlay>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when backdrop is clicked", async () => {
    render(
      <AnimatedOverlay open onClose={onClose} className="dialog">
        <span>Content</span>
      </AnimatedOverlay>,
    );
    const backdrop = screen.getByTestId("animated-overlay-backdrop");
    await userEvent.pointer([
      { target: backdrop, keys: "[MouseLeft>]" },
      { target: backdrop, keys: "[/MouseLeft]" },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when content area is clicked", async () => {
    render(
      <AnimatedOverlay open onClose={onClose} className="dialog">
        <button type="button">Inner</button>
      </AnimatedOverlay>,
    );
    await userEvent.click(screen.getByText("Inner"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
