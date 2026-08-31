// @vitest-environment happy-dom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function PassiveAutofocusChild() {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <button ref={ref} type="button">
      Passive autofocus action
    </button>
  );
}

function LayoutAutofocusChild() {
  const ref = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);

  return <input ref={ref} aria-label="Layout autofocus input" />;
}

function OverlayHarness({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open overlay
      </button>
      <AnimatedOverlay
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        className="dialog"
      >
        {children}
      </AnimatedOverlay>
    </>
  );
}

function ConditionalOverlayHarness({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open conditional overlay
      </button>
      {open && (
        <AnimatedOverlay open onClose={() => setOpen(false)} className="dialog">
          {children}
        </AnimatedOverlay>
      )}
    </>
  );
}

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

  it("moves initial focus inside the overlay", async () => {
    const view = render(<button type="button">Opener</button>);
    screen.getByRole("button", { name: "Opener" }).focus();
    view.rerender(
      <>
        <button type="button">Opener</button>
        <AnimatedOverlay open onClose={onClose} className="dialog">
          <button type="button">First dialog action</button>
        </AnimatedOverlay>
      </>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "First dialog action" }),
      ).toHaveFocus(),
    );
  });

  it("keeps the current focus and uses the latest onClose while open", async () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const view = render(
      <AnimatedOverlay open onClose={firstClose} className="dialog">
        <button type="button">First dialog action</button>
        <input aria-label="Import name" />
      </AnimatedOverlay>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "First dialog action" }),
      ).toHaveFocus(),
    );
    const input = screen.getByRole("textbox", { name: "Import name" });
    input.focus();

    view.rerender(
      <AnimatedOverlay open onClose={latestClose} className="dialog">
        <button type="button">First dialog action</button>
        <input aria-label="Import name" />
      </AnimatedOverlay>,
    );
    await Promise.resolve();

    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the connected opener when closed", async () => {
    const view = render(
      <>
        <button type="button">Opener</button>
        <AnimatedOverlay open={false} onClose={onClose} className="dialog">
          <button type="button">Dialog action</button>
        </AnimatedOverlay>
      </>,
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();

    view.rerender(
      <>
        <button type="button">Opener</button>
        <AnimatedOverlay open onClose={onClose} className="dialog">
          <button type="button">Dialog action</button>
        </AnimatedOverlay>
      </>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Dialog action" }),
      ).toHaveFocus(),
    );

    view.rerender(
      <>
        <button type="button">Opener</button>
        <AnimatedOverlay open={false} onClose={onClose} className="dialog">
          <button type="button">Dialog action</button>
        </AnimatedOverlay>
      </>,
    );

    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("restores focus to the opener captured before a child passive effect focuses inside", async () => {
    const view = render(
      <>
        <button type="button">Opener</button>
        <AnimatedOverlay open={false} onClose={onClose} className="dialog">
          <PassiveAutofocusChild />
        </AnimatedOverlay>
      </>,
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();

    view.rerender(
      <>
        <button type="button">Opener</button>
        <AnimatedOverlay open onClose={onClose} className="dialog">
          <PassiveAutofocusChild />
        </AnimatedOverlay>
      </>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Passive autofocus action" }),
      ).toHaveFocus(),
    );

    view.rerender(
      <>
        <button type="button">Opener</button>
        <AnimatedOverlay open={false} onClose={onClose} className="dialog">
          <PassiveAutofocusChild />
        </AnimatedOverlay>
      </>,
    );

    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("restores the opener after a child autoFocus", async () => {
    render(
      <OverlayHarness>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input autoFocus aria-label="Autofocus input" />
      </OverlayHarness>,
    );

    const opener = screen.getByRole("button", { name: "Open overlay" });
    opener.focus();
    fireEvent.click(opener);
    const input = await screen.findByRole("textbox", {
      name: "Autofocus input",
    });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("restores the opener after a child layout effect focuses inside", async () => {
    render(
      <OverlayHarness>
        <LayoutAutofocusChild />
      </OverlayHarness>,
    );

    const opener = screen.getByRole("button", { name: "Open overlay" });
    opener.focus();
    fireEvent.click(opener);
    const input = await screen.findByRole("textbox", {
      name: "Layout autofocus input",
    });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("recaptures the opener when a persistent overlay is reopened", async () => {
    render(
      <OverlayHarness>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input autoFocus aria-label="Reopened autofocus input" />
      </OverlayHarness>,
    );

    const opener = screen.getByRole("button", { name: "Open overlay" });
    for (let openCount = 0; openCount < 2; openCount++) {
      opener.focus();
      fireEvent.click(opener);
      const input = await screen.findByRole("textbox", {
        name: "Reopened autofocus input",
      });
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(opener).toHaveFocus());
    }
  });

  it("keeps the opener through StrictMode effect replay and restores it after a conditional close", async () => {
    render(
      <StrictMode>
        <ConditionalOverlayHarness>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus aria-label="Strict autofocus input" />
        </ConditionalOverlayHarness>
      </StrictMode>,
    );

    const opener = screen.getByRole("button", {
      name: "Open conditional overlay",
    });
    const onOpenerFocus = vi.fn();
    opener.addEventListener("focus", onOpenerFocus);
    opener.focus();
    fireEvent.click(opener);

    const input = await screen.findByRole("textbox", {
      name: "Strict autofocus input",
    });
    expect(input).toHaveFocus();
    expect(onOpenerFocus).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(onOpenerFocus).toHaveBeenCalledTimes(2);
    opener.removeEventListener("focus", onOpenerFocus);
  });

  it("restores focus to the connected opener when unmounted", async () => {
    render(<button type="button">External opener</button>);
    const opener = screen.getByRole("button", { name: "External opener" });
    opener.focus();
    const overlay = render(
      <AnimatedOverlay open onClose={onClose} className="dialog">
        <button type="button">Dialog action</button>
      </AnimatedOverlay>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Dialog action" }),
      ).toHaveFocus(),
    );
    overlay.unmount();

    await waitFor(() => expect(opener).toHaveFocus());
  });
});
