// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));

import { toast } from "sonner";
import { useInlineAiStore } from "./inlineAiStore";
import type { InlineAiStatus } from "./inlineAiTypes";
import {
  isInlineAiPending,
  guardInlineAiPending,
  resetPendingGuardThrottle,
} from "./pendingGuard";

const mockToastInfo = vi.mocked(toast.info);

function setStatus(status: InlineAiStatus): void {
  useInlineAiStore.setState({ status });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPendingGuardThrottle();
  useInlineAiStore.setState({ status: "idle", attentionNonce: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isInlineAiPending", () => {
  it("returns false when idle", () => {
    setStatus("idle");
    expect(isInlineAiPending()).toBe(false);
  });

  it("returns true for generating / diffShown / error", () => {
    for (const s of ["generating", "diffShown", "error"] as InlineAiStatus[]) {
      setStatus(s);
      expect(isInlineAiPending()).toBe(true);
    }
  });
});

describe("guardInlineAiPending", () => {
  it("returns false and does not notify when idle", () => {
    expect(guardInlineAiPending()).toBe(false);
    expect(mockToastInfo).not.toHaveBeenCalled();
    expect(useInlineAiStore.getState().attentionNonce).toBe(0);
  });

  it("returns true, toasts, and bumps attentionNonce when pending", () => {
    useInlineAiStore.setState({ status: "diffShown", attentionNonce: 0 });
    expect(guardInlineAiPending()).toBe(true);
    expect(mockToastInfo).toHaveBeenCalledWith("inlineAi.pendingBlocked");
    expect(useInlineAiStore.getState().attentionNonce).toBe(1);
  });

  it("throttles toast/attention within the window but always returns true", () => {
    vi.useFakeTimers();
    useInlineAiStore.setState({ status: "diffShown", attentionNonce: 0 });
    // One user action hitting two chokepoints (tabStore + treeStore):
    expect(guardInlineAiPending()).toBe(true);
    expect(guardInlineAiPending()).toBe(true);
    expect(mockToastInfo).toHaveBeenCalledTimes(1);
    expect(useInlineAiStore.getState().attentionNonce).toBe(1);
    // After the throttle window a fresh attempt notifies again.
    vi.advanceTimersByTime(400);
    expect(guardInlineAiPending()).toBe(true);
    expect(mockToastInfo).toHaveBeenCalledTimes(2);
    expect(useInlineAiStore.getState().attentionNonce).toBe(2);
  });

  it("silent option blocks without toasting or shaking", () => {
    useInlineAiStore.setState({ status: "generating", attentionNonce: 0 });
    expect(guardInlineAiPending({ silent: true })).toBe(true);
    expect(mockToastInfo).not.toHaveBeenCalled();
    expect(useInlineAiStore.getState().attentionNonce).toBe(0);
  });
});
