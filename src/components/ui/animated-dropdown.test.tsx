// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

describe("AnimatedDropdown focus restore (inline)", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
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
          <AnimatedDropdown
            open={open}
            onClose={() => setOpen(false)}
            containerRef={containerRef}
          >
            <button type="button" data-testid="item">
              item
            </button>
          </AnimatedDropdown>
        </div>
        <button type="button" data-testid="outside">
          outside
        </button>
      </div>
    );
  }

  it("restores focus to the trigger when closed via Escape", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByTestId("item"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("item")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not restore focus when closed by outside click", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("trigger"));
    const outside = screen.getByTestId("outside");
    await userEvent.click(outside);
    expect(screen.queryByTestId("item")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});

describe("AnimatedDropdown anchored mode focus", () => {
  function Harness({ menu }: { menu?: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    return (
      <div>
        <button
          ref={triggerRef}
          type="button"
          data-testid="trigger"
          onClick={() => setOpen((v) => !v)}
        >
          trigger
        </button>
        <AnimatedDropdown
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
        >
          {menu ?? (
            <>
              <button type="button" data-testid="item-1">
                Item 1
              </button>
              <button type="button" data-testid="item-2">
                Item 2
              </button>
            </>
          )}
        </AnimatedDropdown>
        <button type="button" data-testid="outside">
          outside
        </button>
      </div>
    );
  }

  it("moves focus to the first focusable element on open", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("trigger"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("item-1")),
    );
  });

  it("focuses the content container (tabindex=-1) when no focusable children", async () => {
    render(<Harness menu={<span data-testid="plain">plain</span>} />);
    await userEvent.click(screen.getByTestId("trigger"));
    await waitFor(() => {
      const active = document.activeElement as HTMLElement;
      expect(active.getAttribute("tabindex")).toBe("-1");
      expect(active.contains(screen.getByTestId("plain"))).toBe(true);
    });
  });

  it("keeps caller-managed focus (autoFocus inside content) on open", async () => {
    render(
      <Harness
        menu={
          <>
            <button type="button" data-testid="first-btn">
              first
            </button>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input data-testid="search" autoFocus />
          </>
        }
      />,
    );
    await userEvent.click(screen.getByTestId("trigger"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("search")),
    );
  });

  it("restores focus to the trigger when closed via Escape", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    await userEvent.click(trigger);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("item-1")),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("item-1")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("does not restore focus when closed by outside click", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("trigger"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("item-1")),
    );
    const outside = screen.getByTestId("outside");
    await userEvent.click(outside);
    await waitFor(() => expect(screen.queryByTestId("item-1")).toBeNull());
    expect(document.activeElement).toBe(outside);
  });
});
