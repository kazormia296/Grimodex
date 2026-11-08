// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// DR-DA2-62 (R3-7): the display's chunk fails to load. The rejection of the
// lazy import is caught by the boundary (the old `.catch` is gone), so the
// slot draws nothing and the rest of the app keeps rendering.
const { logged } = vi.hoisted(() => ({
  logged: [] as Array<{ tag: string; message: string }>,
}));
vi.mock("./profileActivationAvailability", () => ({
  PROFILE_ACTIVATION_UI_ENABLED: true,
}));
vi.mock("@/lib/debugLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/debugLog")>()),
  debugLog: {
    error: (tag: string, message: string) => logged.push({ tag, message }),
  },
}));
vi.mock("./ProfileEgressStatusIndicator", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

import { ProfileEgressStatusSlot } from "./ProfileEgressStatusSlot";

describe("profile egress status slot chunk load failure", () => {
  it("draws nothing and logs without reaching the app root", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <div>
        <ProfileEgressStatusSlot />
        <span data-testid="sibling" />
      </div>,
    );
    await act(async () => {});
    expect(screen.getByTestId("sibling")).toBeTruthy();
    expect(logged).toEqual([
      { tag: "ProfileEgressStatus", message: "status display failed" },
    ]);
  });
});
