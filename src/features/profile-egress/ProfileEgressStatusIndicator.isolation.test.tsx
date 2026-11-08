// @vitest-environment happy-dom
// DR-DA2-64: an exception of the status display's rendering (the translation
// call, the markup) must not stop the closure effect of the AI entrances. The
// rendering is a child under its own boundary, so the Indicator's effects still
// commit when the child throws.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileEgressStatusView } from "@/lib/profileEgressStatus";

const { getMock, behavior, logged } = vi.hoisted(() => ({
  getMock: vi.fn<() => Promise<ProfileEgressStatusView>>(),
  behavior: { throwInT: false },
  logged: [] as Array<{ tag: string; message: string }>,
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
  debugLog: {
    warn: () => undefined,
    error: (tag: string, message: string) => logged.push({ tag, message }),
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string) => {
      if (behavior.throwInT) throw new Error("t failed");
      return key;
    },
  }),
}));

import ProfileEgressStatusIndicator from "./ProfileEgressStatusIndicator";
import { ProfileEgressStatusBoundary } from "./ProfileEgressStatusBoundary";
import { useAiSettingsStore } from "@/features/chat/store";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  behavior.throwInT = false;
  logged.length = 0;
  getMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the closure survives an exception of the status rendering", () => {
  it.each([
    [{ state: "restricted" }],
    [{ state: "activating" }],
    [{ state: "unavailable", reason: "status-invalid" }],
  ] as Array<[ProfileEgressStatusView]>)(
    "%o still closes the store while the rendering throws",
    async (view) => {
      useAiSettingsStore.setState({ profileEgressClosed: undefined });
      behavior.throwInT = true;
      getMock.mockImplementation(() => Promise.resolve(view));
      render(
        <ProfileEgressStatusBoundary>
          <ProfileEgressStatusIndicator />
          <span data-testid="sibling" />
        </ProfileEgressStatusBoundary>,
      );
      await settle();
      expect(useAiSettingsStore.getState().profileEgressClosed).toBe(true);
      // Only the inner boundary caught it: the outer one and the sibling stay.
      expect(screen.getByTestId("sibling")).toBeTruthy();
      expect(screen.queryByTestId("profile-egress-status")).toBeNull();
      expect(logged).toEqual([
        { tag: "ProfileEgressStatus", message: "status display failed" },
      ]);
    },
  );
});
