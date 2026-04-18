// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@gsap/react", () => ({
  useGSAP: vi.fn((fn: () => void) => fn()),
}));

vi.mock("gsap", () => {
  const mockTimeline = {
    from: vi.fn().mockReturnThis(),
    to: vi.fn().mockReturnThis(),
    fromTo: vi.fn().mockReturnThis(),
  };
  return { gsap: { timeline: vi.fn(() => mockTimeline) } };
});

vi.mock("@/lib/gsap", () => ({
  isReducedMotion: vi.fn(() => false),
}));

vi.mock("@/features/layout/PanelHighlightOverlay", () => ({
  PanelHighlightOverlay: () => null,
}));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
  };
});

import { gsap } from "gsap";
import { isReducedMotion } from "@/lib/gsap";
import { WelcomeDialog } from "./WelcomeDialog";

describe("WelcomeDialog", () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isReducedMotion).mockReturnValue(false);
  });

  it("renders when open is true", () => {
    render(<WelcomeDialog {...defaultProps} />);
    expect(screen.getByTestId("welcome-dialog")).toBeInTheDocument();
  });

  it("does not render when open is false", () => {
    render(<WelcomeDialog {...defaultProps} open={false} />);
    expect(screen.queryByTestId("welcome-dialog")).not.toBeInTheDocument();
  });

  it("renders all 6 tour steps", () => {
    render(<WelcomeDialog {...defaultProps} />);
    expect(screen.getByTestId("tour-step-scenes")).toBeInTheDocument();
    expect(screen.getByTestId("tour-step-chat")).toBeInTheDocument();
    expect(screen.getByTestId("tour-step-codex")).toBeInTheDocument();
    expect(screen.getByTestId("tour-step-snippets")).toBeInTheDocument();
    expect(screen.getByTestId("tour-step-editor")).toBeInTheDocument();
    expect(screen.getByTestId("tour-step-layout")).toBeInTheDocument();
  });

  it("calls onClose when get-started button is clicked", async () => {
    const user = userEvent.setup();
    render(<WelcomeDialog {...defaultProps} />);
    await user.click(screen.getByTestId("welcome-get-started"));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("starts GSAP timeline on open", () => {
    render(<WelcomeDialog {...defaultProps} />);
    expect(gsap.timeline).toHaveBeenCalled();
  });

  it("does not start GSAP timeline when reduced motion is on", () => {
    vi.mocked(isReducedMotion).mockReturnValue(true);
    render(<WelcomeDialog {...defaultProps} />);
    expect(gsap.timeline).not.toHaveBeenCalled();
  });

  it("calls onClose when Escape key is pressed", async () => {
    const user = userEvent.setup();
    render(<WelcomeDialog {...defaultProps} />);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(defaultProps.onClose).toHaveBeenCalled());
  });

  describe("tour mode", () => {
    it("enters tour mode when a step card is clicked", async () => {
      const user = userEvent.setup();
      render(<WelcomeDialog {...defaultProps} />);
      await user.click(screen.getByTestId("tour-step-scenes"));
      expect(screen.getByTestId("tour-card")).toBeInTheDocument();
      expect(screen.queryByTestId("welcome-dialog")).not.toBeInTheDocument();
    });

    it("enters tour mode from start-tour button", async () => {
      const user = userEvent.setup();
      render(<WelcomeDialog {...defaultProps} />);
      await user.click(screen.getByTestId("tour-start"));
      expect(screen.getByTestId("tour-card")).toBeInTheDocument();
    });

    it("navigates to next step", async () => {
      const user = userEvent.setup();
      render(<WelcomeDialog {...defaultProps} />);
      await user.click(screen.getByTestId("tour-step-scenes"));
      await user.click(screen.getByTestId("tour-next"));
      // Next button still visible (not on last step)
      expect(screen.getByTestId("tour-next")).toBeInTheDocument();
    });

    it("shows get-started on last step instead of next", async () => {
      const user = userEvent.setup();
      render(<WelcomeDialog {...defaultProps} />);
      // Go to last step (layout = index 5)
      await user.click(screen.getByTestId("tour-step-layout"));
      expect(screen.queryByTestId("tour-next")).not.toBeInTheDocument();
      expect(screen.getByTestId("welcome-get-started")).toBeInTheDocument();
    });

    it("returns to overview from back-to-overview button", async () => {
      const user = userEvent.setup();
      render(<WelcomeDialog {...defaultProps} />);
      await user.click(screen.getByTestId("tour-step-chat"));
      await user.click(screen.getByTestId("tour-back"));
      expect(screen.getByTestId("welcome-dialog")).toBeInTheDocument();
    });

    it("closes on Escape in tour mode", async () => {
      const user = userEvent.setup();
      render(<WelcomeDialog {...defaultProps} />);
      await user.click(screen.getByTestId("tour-step-scenes"));
      await user.keyboard("{Escape}");
      await waitFor(() => expect(defaultProps.onClose).toHaveBeenCalled());
    });
  });
});
