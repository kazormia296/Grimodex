// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { ProfileEgressStatusView } from "@/lib/profileEgressStatus";
import { PROFILE_EGRESS_UNAVAILABLE_REASONS } from "@/../electron/shared/profileEgressStatusWire";

type Handler = (view: ProfileEgressStatusView) => void;
const { order, handlers, getMock, onMock, requestMock } = vi.hoisted(() => {
  const order: string[] = [];
  const handlers: Handler[] = [];
  return {
    order,
    handlers,
    getMock: vi.fn<() => Promise<ProfileEgressStatusView>>(),
    onMock: vi.fn((handler: Handler) => {
      order.push("subscribe");
      handlers.push(handler);
      return () => {
        order.push("unsubscribe");
      };
    }),
    requestMock: vi.fn(),
  };
});
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: () => {
    order.push("get");
    return getMock();
  },
  onProfileEgressStatus: onMock,
  requestProfileActivation: requestMock,
}));
// The constant overridden for the rendering tests (the real default is pinned
// by `profileActivationAvailability.test.ts` and `ProfileEgressStatusSlot.test.tsx`).
vi.mock("./profileActivationAvailability", () => ({
  PROFILE_ACTIVATION_UI_ENABLED: true,
}));

import ProfileEgressStatusIndicator from "./ProfileEgressStatusIndicator";
import { ProfileEgressStatusSlot } from "./ProfileEgressStatusSlot";
import { PROFILE_EGRESS_TRANSLATIONS } from "./profileEgressTranslations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function emit(view: ProfileEgressStatusView) {
  act(() => {
    for (const handler of handlers) handler(view);
  });
}

beforeEach(async () => {
  order.length = 0;
  handlers.length = 0;
  getMock.mockReset();
  onMock.mockClear();
  requestMock.mockReset();
  await i18n.changeLanguage("ja");
});
afterEach(() => cleanup());

describe("profile egress status display (DA-2 ST3, Positive (6))", () => {
  it("subscribes before it reads, never sends a request, and unsubscribes on unmount", async () => {
    getMock.mockResolvedValue({ state: "unrestricted" });
    const { unmount } = render(<ProfileEgressStatusIndicator />);
    await act(async () => {});
    expect(order).toEqual(["subscribe", "get"]);
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
    expect(order).toEqual(["subscribe", "get", "unsubscribe"]);
  });

  it("shows nothing while unrestricted, loading or unreadable", async () => {
    const pending = deferred<ProfileEgressStatusView>();
    getMock.mockReturnValue(pending.promise);
    const { container } = render(<ProfileEgressStatusIndicator />);
    expect(container).toBeEmptyDOMElement();
    await act(async () => pending.resolve({ state: "unrestricted" }));
    expect(container).toBeEmptyDOMElement();
    cleanup();

    getMock.mockRejectedValue(new Error("PROFILE_EGRESS_STATUS_INVALID"));
    const second = render(<ProfileEgressStatusIndicator />);
    await act(async () => {});
    expect(second.container).toBeEmptyDOMElement();
  });

  it("always shows restricted, and activating from the stage-2 event", async () => {
    getMock.mockResolvedValue({ state: "unrestricted" });
    render(<ProfileEgressStatusIndicator />);
    await act(async () => {});
    emit({ state: "activating" });
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-profile-egress-state",
      "activating",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      PROFILE_EGRESS_TRANSLATIONS.ja.status.activating,
    );
    emit({ state: "restricted" });
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-profile-egress-state", "restricted");
    expect(status).toHaveTextContent(
      PROFILE_EGRESS_TRANSLATIONS.ja.status.restricted,
    );
    expect(status).toHaveTextContent(
      PROFILE_EGRESS_TRANSLATIONS.ja.status.restrictedDetail,
    );
  });

  it.each(PROFILE_EGRESS_UNAVAILABLE_REASONS)(
    "shows the reason and the recovery step for unavailable (%s), from the code only",
    async (reason) => {
      getMock.mockResolvedValue({ state: "unavailable", reason });
      render(<ProfileEgressStatusIndicator />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveAttribute("data-profile-egress-reason", reason);
      expect(alert).toHaveTextContent(
        PROFILE_EGRESS_TRANSLATIONS.ja.reason[reason],
      );
      expect(alert).toHaveTextContent(
        PROFILE_EGRESS_TRANSLATIONS.ja.status.unavailableNote,
      );
      expect(alert.textContent).not.toContain("profileEgress.");
    },
  );

  it("never moves backwards when the read's answer races an event", async () => {
    const pending = deferred<ProfileEgressStatusView>();
    getMock.mockReturnValue(pending.promise);
    render(<ProfileEgressStatusIndicator />);
    emit({ state: "activating" });
    emit({ state: "restricted" });
    // The read was answered before stage 2 but arrives after both events.
    await act(async () => pending.resolve({ state: "unrestricted" }));
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-profile-egress-state",
      "restricted",
    );
    // A later failure event still replaces restricted (the same rank).
    emit({ state: "unavailable", reason: "barrier-timeout" });
    expect(screen.getByRole("alert")).toHaveAttribute(
      "data-profile-egress-reason",
      "barrier-timeout",
    );
  });

  it("takes the read's answer when it is newer than what the events said", async () => {
    const pending = deferred<ProfileEgressStatusView>();
    getMock.mockReturnValue(pending.promise);
    render(<ProfileEgressStatusIndicator />);
    emit({ state: "activating" });
    await act(async () => pending.resolve({ state: "restricted" }));
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-profile-egress-state",
      "restricted",
    );
  });

  it("shows the English strings in en", async () => {
    await i18n.changeLanguage("en");
    getMock.mockResolvedValue({
      state: "unavailable",
      reason: "state-file-unreadable",
    });
    render(<ProfileEgressStatusIndicator />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      PROFILE_EGRESS_TRANSLATIONS.en.reason["state-file-unreadable"],
    );
  });

  it("is mounted by the slot while the constant is on", async () => {
    getMock.mockResolvedValue({ state: "restricted" });
    render(<ProfileEgressStatusSlot />);
    expect(await screen.findByRole("status")).toHaveAttribute(
      "data-profile-egress-state",
      "restricted",
    );
  });
});
