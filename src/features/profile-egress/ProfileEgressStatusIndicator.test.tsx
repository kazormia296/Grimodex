// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
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

  it("never lets a read's answer of the same rank replace an event's view (R3-1)", async () => {
    const pending = deferred<ProfileEgressStatusView>();
    getMock.mockReturnValue(pending.promise);
    render(<ProfileEgressStatusIndicator />);
    emit({ state: "unavailable", reason: "participant-timeout" });
    // The read was answered at stage 6 but arrives after the failure event.
    await act(async () => pending.resolve({ state: "restricted" }));
    expect(screen.getByRole("alert")).toHaveAttribute(
      "data-profile-egress-reason",
      "participant-timeout",
    );
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();

    const second = deferred<ProfileEgressStatusView>();
    getMock.mockReturnValue(second.promise);
    render(<ProfileEgressStatusIndicator />);
    emit({ state: "restricted" });
    await act(async () =>
      second.resolve({ state: "unavailable", reason: "barrier-timeout" }),
    );
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-profile-egress-state",
      "restricted",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does nothing for an event or an answer after the unmount (R3-2 (a))", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = deferred<ProfileEgressStatusView>();
      getMock.mockReturnValue(pending.promise);
      const { container, unmount } = render(<ProfileEgressStatusIndicator />);
      unmount();
      emit({ state: "restricted" });
      await act(async () => pending.resolve({ state: "restricted" }));
      expect(container).toBeEmptyDOMElement();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("pairs every subscribe with an unsubscribe under StrictMode and ignores the cleaned-up effect (R3-2 (b))", async () => {
    const first = deferred<ProfileEgressStatusView>();
    const second = deferred<ProfileEgressStatusView>();
    getMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { container, unmount } = render(
      <StrictMode>
        <ProfileEgressStatusIndicator />
      </StrictMode>,
    );
    expect(order).toEqual([
      "subscribe",
      "get",
      "unsubscribe",
      "subscribe",
      "get",
    ]);
    expect(handlers).toHaveLength(2);
    // The first effect was cleaned up: its read's answer and a last event its
    // listener still receives change nothing.
    await act(async () => first.resolve({ state: "restricted" }));
    act(() => handlers[0]!({ state: "activating" }));
    expect(container).toBeEmptyDOMElement();
    // The live effect shows its answer once.
    await act(async () => second.resolve({ state: "restricted" }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    unmount();
    expect(order.filter((step) => step === "subscribe")).toHaveLength(2);
    expect(order.filter((step) => step === "unsubscribe")).toHaveLength(2);
  });

  it("tells for state-file-unwritable both states the restart can lead to (ST3-S1, R3)", () => {
    for (const language of ["ja", "en"] as const) {
      const text =
        PROFILE_EGRESS_TRANSLATIONS[language].reason["state-file-unwritable"];
      expect(text).toContain("userData");
      if (language === "ja") {
        expect(text).toContain("成立していれば制限中");
        expect(text).toContain("成立していなければ制限なし");
      } else {
        expect(text).toContain("is on if turning it on took effect");
        expect(text).toContain("off if it did not");
      }
    }
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

// DA-2b の PUB-G 前の必須 3・4（DR-DA2B-R22）：状態の表示は AI の入口の閉鎖の唯一の
// 書き手。unrestricted 以外の既知の状態で閉じ、読めない（unknown）間と unrestricted では
// 閉じない。
describe("the AI entrances' closure written by the status display", () => {
  async function closureAfter(
    answer: () => Promise<ProfileEgressStatusView>,
  ): Promise<{ store: boolean; local: boolean }> {
    const { useAiSettingsStore } = await import("@/features/chat/store");
    useAiSettingsStore.setState({ profileEgressClosed: undefined });
    globalThis.__grimodexProfileEgressLocalRefusal = undefined;
    getMock.mockImplementation(answer);
    render(<ProfileEgressStatusIndicator />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return {
      store: useAiSettingsStore.getState().profileEgressClosed === true,
      local: globalThis.__grimodexProfileEgressLocalRefusal !== undefined,
    };
  }

  afterEach(async () => {
    const { useAiSettingsStore } = await import("@/features/chat/store");
    useAiSettingsStore.setState({ profileEgressClosed: undefined });
    globalThis.__grimodexProfileEgressLocalRefusal = undefined;
  });

  it.each([
    [{ state: "restricted" }],
    [{ state: "activating" }],
    [{ state: "unavailable", reason: "status-invalid" }],
  ] as Array<[ProfileEgressStatusView]>)(
    "%o closes both homes",
    async (view) => {
      expect(await closureAfter(() => Promise.resolve(view))).toEqual({
        store: true,
        local: true,
      });
    },
  );

  it.each([
    ["unrestricted", () => Promise.resolve({ state: "unrestricted" } as const)],
    ["an unreadable state", () => Promise.reject(new Error("bridge"))],
  ] as Array<[string, () => Promise<ProfileEgressStatusView>]>)(
    "%s leaves them open",
    async (_label, answer) => {
      expect(await closureAfter(answer)).toEqual({
        store: false,
        local: false,
      });
    },
  );

  it("closes on the stage-2 event after an unrestricted answer", async () => {
    expect(
      await closureAfter(() => Promise.resolve({ state: "unrestricted" })),
    ).toEqual({ store: false, local: false });
    emit({ state: "activating" });
    const { useAiSettingsStore } = await import("@/features/chat/store");
    expect(useAiSettingsStore.getState().profileEgressClosed).toBe(true);
    expect(globalThis.__grimodexProfileEgressLocalRefusal).toBeTypeOf(
      "function",
    );
  });
});
