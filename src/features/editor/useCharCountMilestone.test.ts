// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("canvas-confetti", () => ({ default: vi.fn() }));
vi.mock("@/lib/gsap", () => ({
  isReducedMotion: vi.fn(() => false),
  pulseHighlight: vi.fn(),
}));

import confetti from "canvas-confetti";
import { isReducedMotion, pulseHighlight } from "@/lib/gsap";
import { useCharCountMilestone } from "./useCharCountMilestone";

function makeRef(el: HTMLElement | null = document.createElement("span")) {
  return { current: el };
}

describe("useCharCountMilestone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isReducedMotion).mockReturnValue(false);
  });

  it("does nothing when target is 0", () => {
    const ref = makeRef();
    renderHook(() => useCharCountMilestone(100, 0, ref));
    expect(pulseHighlight).not.toHaveBeenCalled();
    expect(confetti).not.toHaveBeenCalled();
  });

  it("does nothing on initial mount even if at milestone", () => {
    const ref = makeRef();
    renderHook(() => useCharCountMilestone(500, 500, ref));
    expect(pulseHighlight).not.toHaveBeenCalled();
    expect(confetti).not.toHaveBeenCalled();
  });

  it("fires pulseHighlight when crossing 25% milestone", () => {
    const ref = makeRef();
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 240 } },
    );
    rerender({ count: 250 });
    expect(pulseHighlight).toHaveBeenCalledWith(ref.current);
    expect(confetti).not.toHaveBeenCalled();
  });

  it("fires pulseHighlight when crossing 50% milestone", () => {
    const ref = makeRef();
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 490 } },
    );
    rerender({ count: 500 });
    expect(pulseHighlight).toHaveBeenCalledWith(ref.current);
    expect(confetti).not.toHaveBeenCalled();
  });

  it("fires pulseHighlight when crossing 75% milestone", () => {
    const ref = makeRef();
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 740 } },
    );
    rerender({ count: 750 });
    expect(pulseHighlight).toHaveBeenCalledWith(ref.current);
    expect(confetti).not.toHaveBeenCalled();
  });

  it("fires pulseHighlight and confetti when crossing 100% (target reached)", () => {
    const ref = makeRef();
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 990 } },
    );
    rerender({ count: 1000 });
    expect(pulseHighlight).toHaveBeenCalledWith(ref.current);
    expect(confetti).toHaveBeenCalled();
  });

  it("does not fire again for a milestone already passed", () => {
    const ref = makeRef();
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 240 } },
    );
    rerender({ count: 250 }); // cross 25%
    vi.clearAllMocks();
    rerender({ count: 260 }); // still above 25%, no new milestone
    expect(pulseHighlight).not.toHaveBeenCalled();
  });

  it("skips animations when reduced motion is enabled", () => {
    vi.mocked(isReducedMotion).mockReturnValue(true);
    const ref = makeRef();
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 990 } },
    );
    rerender({ count: 1000 });
    expect(pulseHighlight).not.toHaveBeenCalled();
    expect(confetti).not.toHaveBeenCalled();
  });

  it("does not fire confetti when document loads with charCount already at target", () => {
    const ref = makeRef();
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 0 } },
    );
    rerender({ count: 1000 });
    expect(confetti).not.toHaveBeenCalled();
    expect(pulseHighlight).not.toHaveBeenCalled();
  });

  it("does not fire when document loads above target", () => {
    const ref = makeRef();
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 0 } },
    );
    rerender({ count: 1200 });
    expect(confetti).not.toHaveBeenCalled();
    expect(pulseHighlight).not.toHaveBeenCalled();
  });

  it("still fires confetti when user types up to target from below-target document", () => {
    const ref = makeRef();
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 0 } },
    );
    rerender({ count: 990 }); // content loads below target (0.25/0.5/0.75 seeded)
    rerender({ count: 1000 }); // user types to target
    expect(confetti).toHaveBeenCalled();
  });

  it("does nothing when element ref is null", () => {
    const ref = makeRef(null);
    const { rerender } = renderHook(
      ({ count }: { count: number }) => useCharCountMilestone(count, 1000, ref),
      { initialProps: { count: 990 } },
    );
    expect(() => rerender({ count: 1000 })).not.toThrow();
    expect(confetti).not.toHaveBeenCalled();
  });
});
