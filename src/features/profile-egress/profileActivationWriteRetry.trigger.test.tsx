// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileEgressStatusView } from "@/lib/profileEgressStatus";

// W-1 (DR-DA2B-R8): the status display starts the retry when this renderer
// sees the activation complete, and only then.

type Handler = (view: ProfileEgressStatusView) => void;
const h = vi.hoisted(() => ({
  handlers: [] as Handler[],
  getMock: vi.fn<() => Promise<ProfileEgressStatusView>>(),
  flush: vi.fn<() => Promise<void>>(),
}));
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: () => h.getMock(),
  onProfileEgressStatus: (handler: Handler) => {
    h.handlers.push(handler);
    return () => {};
  },
  requestProfileActivation: vi.fn(),
}));
vi.mock("@/application/lifecycle/quiescenceCoordinator", () => ({
  flushStrictQuiescence: h.flush,
}));
vi.mock("@/features/project/projectStore", () => ({}));

import ProfileEgressStatusIndicator from "./ProfileEgressStatusIndicator";
import {
  ACTIVATION_WRITE_RETRY_DELAYS_MS,
  _resetWritesRetryAfterActivationForTests,
} from "./profileActivationWriteRetry";

function emit(view: ProfileEgressStatusView) {
  act(() => {
    for (const handler of h.handlers) handler(view);
  });
}

async function mountReading(view: ProfileEgressStatusView) {
  h.getMock.mockResolvedValue(view);
  render(
    <StrictMode>
      <ProfileEgressStatusIndicator />
    </StrictMode>,
  );
  await act(async () => {});
}

async function afterAllAttempts() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(
      ACTIVATION_WRITE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.handlers.length = 0;
  h.getMock.mockReset();
  h.flush.mockReset();
  h.flush.mockResolvedValue(undefined);
  _resetWritesRetryAfterActivationForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the status display starts the W-1 retry", () => {
  it("flushes once after the activation completes (unrestricted → activating → restricted)", async () => {
    await mountReading({ state: "unrestricted" });
    emit({ state: "activating" });
    await afterAllAttempts();
    expect(h.flush).not.toHaveBeenCalled();

    emit({ state: "restricted" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_WRITE_RETRY_DELAYS_MS[0]);
    });
    expect(h.flush).toHaveBeenCalledTimes(1);

    // A repeated event or a second display does not start another retry.
    emit({ state: "restricted" });
    render(<ProfileEgressStatusIndicator />);
    await afterAllAttempts();
    expect(h.flush).toHaveBeenCalledTimes(1);
  });

  it("does not retry in a process that starts restricted", async () => {
    await mountReading({ state: "restricted" });
    emit({ state: "restricted" });
    await afterAllAttempts();
    expect(h.flush).not.toHaveBeenCalled();
  });

  it("does not retry when the activation fails (unavailable)", async () => {
    await mountReading({ state: "unrestricted" });
    emit({ state: "activating" });
    emit({ state: "unavailable", reason: "barrier-timeout" });
    await afterAllAttempts();
    expect(h.flush).not.toHaveBeenCalled();
  });
});
