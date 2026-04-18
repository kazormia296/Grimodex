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

  it("renders all 4 tour steps", () => {
    render(<WelcomeDialog {...defaultProps} />);
    expect(screen.getByTestId("tour-step-scenes")).toBeInTheDocument();
    expect(screen.getByTestId("tour-step-chat")).toBeInTheDocument();
    expect(screen.getByTestId("tour-step-codex")).toBeInTheDocument();
    expect(screen.getByTestId("tour-step-snippets")).toBeInTheDocument();
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
});
