// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DR-DA2-62 (R3-7): with the constant on, a failure of the status display
// (chunk load, module evaluation, render or effect) draws nothing and is
// logged; it never reaches the app root. The display is the mocked
// `./ProfileEgressStatusIndicator`, replaced per test.
const { behavior, logged } = vi.hoisted(() => ({
  behavior: { current: "ok" as "ok" | "render" | "effect" },
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
vi.mock("./ProfileEgressStatusIndicator", async () => {
  const { useEffect } = await import("react");
  return {
    default: function Indicator() {
      if (behavior.current === "render") throw new Error("render failed");
      useEffect(() => {
        if (behavior.current === "effect") throw new Error("effect failed");
      }, []);
      return <div data-testid="indicator" />;
    },
  };
});

import { ProfileEgressStatusSlot } from "./ProfileEgressStatusSlot";

beforeEach(() => {
  behavior.current = "ok";
  logged.length = 0;
  // React logs a caught error to the console; the assertions below read the
  // boundary's own log instead.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("profile egress status slot error boundary", () => {
  it("mounts the display when nothing fails", async () => {
    render(<ProfileEgressStatusSlot />);
    expect(await screen.findByTestId("indicator")).toBeTruthy();
    expect(logged).toEqual([]);
  });

  for (const failure of ["render", "effect"] as const) {
    it(`draws nothing and logs when the display throws in its ${failure}`, async () => {
      behavior.current = failure;
      const { container } = render(
        <div data-testid="app">
          <ProfileEgressStatusSlot />
          <span data-testid="sibling" />
        </div>,
      );
      await act(async () => {});
      expect(screen.queryByTestId("indicator")).toBeNull();
      expect(screen.getByTestId("sibling")).toBeTruthy();
      expect(container.querySelector('[data-testid="app"]')).not.toBeNull();
      expect(logged).toEqual([
        { tag: "ProfileEgressStatus", message: "status display failed" },
      ]);
    });
  }
});
