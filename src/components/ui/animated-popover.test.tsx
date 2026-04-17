// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";

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

import { AnimatedPopover } from "./animated-popover";

describe("AnimatedPopover", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
  });

  it("renders children when open", () => {
    render(
      <AnimatedPopover open onClose={onClose}>
        <span>Popover content</span>
      </AnimatedPopover>,
    );
    expect(screen.getByText("Popover content")).toBeTruthy();
  });

  it("does not render children when closed", () => {
    render(
      <AnimatedPopover open={false} onClose={onClose}>
        <span>Popover content</span>
      </AnimatedPopover>,
    );
    expect(screen.queryByText("Popover content")).toBeNull();
  });

  it("calls onClose when Escape is pressed while open", async () => {
    render(
      <AnimatedPopover open onClose={onClose}>
        <span>Popover content</span>
      </AnimatedPopover>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on outside click when containerRef provided", async () => {
    function Wrapper() {
      const containerRef = useRef<HTMLDivElement>(null);
      return (
        <div>
          <div ref={containerRef} data-testid="container">
            <AnimatedPopover open onClose={onClose} containerRef={containerRef}>
              <span>Popover content</span>
            </AnimatedPopover>
          </div>
          <button type="button" data-testid="outside">
            Outside
          </button>
        </div>
      );
    }
    render(<Wrapper />);
    await userEvent.click(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("works without onClose (read-only popover)", () => {
    expect(() => {
      render(
        <AnimatedPopover open>
          <span>No close</span>
        </AnimatedPopover>,
      );
    }).not.toThrow();
  });
});
