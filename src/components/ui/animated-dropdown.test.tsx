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

import { AnimatedDropdown } from "./animated-dropdown";

describe("AnimatedDropdown", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
  });

  it("renders children when open", () => {
    render(
      <AnimatedDropdown open onClose={onClose}>
        <span>Menu</span>
      </AnimatedDropdown>,
    );
    expect(screen.getByText("Menu")).toBeTruthy();
  });

  it("does not render children when closed", () => {
    render(
      <AnimatedDropdown open={false} onClose={onClose}>
        <span>Menu</span>
      </AnimatedDropdown>,
    );
    expect(screen.queryByText("Menu")).toBeNull();
  });

  it("calls onClose when Escape is pressed while open", async () => {
    render(
      <AnimatedDropdown open onClose={onClose}>
        <span>Menu</span>
      </AnimatedDropdown>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClose from Escape when closed", async () => {
    render(
      <AnimatedDropdown open={false} onClose={onClose}>
        <span>Menu</span>
      </AnimatedDropdown>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on outside click when containerRef is provided", async () => {
    function Wrapper() {
      const containerRef = useRef<HTMLDivElement>(null);
      return (
        <div>
          <div ref={containerRef} data-testid="container">
            <button type="button">Trigger</button>
            <AnimatedDropdown
              open
              onClose={onClose}
              containerRef={containerRef}
            >
              <span>Menu</span>
            </AnimatedDropdown>
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
});
