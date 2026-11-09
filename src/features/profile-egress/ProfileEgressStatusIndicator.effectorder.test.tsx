// @vitest-environment happy-dom
// DR-DA2-64: React runs one component's effects in a single loop under one try,
// so an effect that throws synchronously skips the effects declared after it.
// The closure effect of the AI entrances is declared before every other effect
// of the Indicator, so a later effect (the write retry) that throws cannot skip
// it.
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileEgressStatusView } from "@/lib/profileEgressStatus";

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<() => Promise<ProfileEgressStatusView>>(),
}));
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: () => getMock(),
  onProfileEgressStatus: () => () => {},
  requestProfileActivation: vi.fn(),
}));
vi.mock("./profileActivationAvailability", () => ({
  PROFILE_ACTIVATION_UI_ENABLED: true,
}));
vi.mock("@/lib/debugLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/debugLog")>()),
  debugLog: { warn: () => undefined, error: () => undefined },
}));
// The write retry's effect throws synchronously once the state is known.
vi.mock("./profileActivationWriteRetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./profileActivationWriteRetry")>()),
  useWritesRetryAfterActivation: (snapshot: { kind: string }) => {
    useEffect(() => {
      if (snapshot.kind === "known") throw new Error("retry effect failed");
    }, [snapshot.kind]);
  },
}));

import ProfileEgressStatusIndicator from "./ProfileEgressStatusIndicator";
import { ProfileEgressStatusBoundary } from "./ProfileEgressStatusBoundary";
import { useAiSettingsStore } from "@/features/chat/store";

beforeEach(() => {
  getMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the closure survives a later effect that throws", () => {
  it.each([
    [{ state: "restricted" }],
    [{ state: "activating" }],
    [{ state: "unavailable", reason: "status-invalid" }],
  ] as Array<[ProfileEgressStatusView]>)(
    "%o still closes the store",
    async (view) => {
      useAiSettingsStore.setState({ profileEgressClosed: undefined });
      getMock.mockImplementation(() => Promise.resolve(view));
      render(
        <ProfileEgressStatusBoundary>
          <ProfileEgressStatusIndicator />
          <span data-testid="sibling" />
        </ProfileEgressStatusBoundary>,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(useAiSettingsStore.getState().profileEgressClosed).toBe(true);
      expect(screen.queryByTestId("sibling")).toBeNull();
    },
  );
});
