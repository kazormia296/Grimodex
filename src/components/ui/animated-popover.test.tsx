// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";

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

describe("AnimatedPopover focus restore", () => {
  function Harness({
    itemClosesAndFocusesInput = false,
  }: {
    itemClosesAndFocusesInput?: boolean;
  }) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    return (
      <div>
        <div ref={containerRef}>
          <button
            type="button"
            data-testid="trigger"
            onClick={() => setOpen((v) => !v)}
          >
            trigger
          </button>
          <AnimatedPopover
            open={open}
            onClose={() => setOpen(false)}
            containerRef={containerRef}
          >
            <button
              type="button"
              data-testid="item"
              onClick={() => {
                if (itemClosesAndFocusesInput) {
                  setOpen(false);
                  inputRef.current?.focus();
                }
              }}
            >
              item
            </button>
          </AnimatedPopover>
        </div>
        <button type="button" data-testid="outside">
          outside
        </button>
        <div data-testid="outside-plain">plain</div>
        <input ref={inputRef} data-testid="other-input" />
      </div>
    );
  }

  it("restores focus to the trigger when closed via Escape", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    await userEvent.click(trigger);
    // フォーカスをポップオーバー内へ移してから Escape で閉じる。
    await userEvent.click(screen.getByTestId("item"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("item")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not restore focus when closed by clicking a focusable element outside", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("trigger"));
    const outside = screen.getByTestId("outside");
    await userEvent.click(outside);
    expect(screen.queryByTestId("item")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("does not restore focus when closed by clicking a non-focusable area outside", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByTestId("outside-plain"));
    expect(screen.queryByTestId("item")).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });

  it("does not steal focus when the caller moves focus on close", async () => {
    render(<Harness itemClosesAndFocusesInput />);
    await userEvent.click(screen.getByTestId("trigger"));
    await userEvent.click(screen.getByTestId("item"));
    expect(screen.queryByTestId("item")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("other-input"));
  });
});
