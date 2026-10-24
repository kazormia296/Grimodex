// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type {
  ProfileActivationRequestResult,
  ProfileEgressStatusView,
} from "@/lib/profileEgressStatus";
import { PROFILE_ACTIVATION_REQUEST_STATUSES } from "@/../electron/shared/profileEgressStatusWire";

type Handler = (view: ProfileEgressStatusView) => void;
const { handlers, getMock, requestMock } = vi.hoisted(() => ({
  handlers: [] as Handler[],
  getMock: vi.fn<() => Promise<ProfileEgressStatusView>>(),
  requestMock: vi.fn<() => Promise<ProfileActivationRequestResult>>(),
}));
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: () => getMock(),
  onProfileEgressStatus: (handler: Handler) => {
    handlers.push(handler);
    return () => undefined;
  },
  requestProfileActivation: () => requestMock(),
}));
vi.mock("./profileActivationAvailability", () => ({
  PROFILE_ACTIVATION_UI_ENABLED: true,
}));

import ProfileActivationGuidance from "./ProfileActivationGuidance";
import ProfileActivationSettingsSection from "./ProfileActivationSettingsSection";
import { PROFILE_EGRESS_TRANSLATIONS } from "./profileEgressTranslations";
import { useProfileActivationRequest } from "./useProfileActivationRequest";

const ja = PROFILE_EGRESS_TRANSLATIONS.ja;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  handlers.length = 0;
  getMock.mockReset();
  requestMock.mockReset();
  await i18n.changeLanguage("ja");
});
afterEach(() => cleanup());

describe("profile activation settings item (K3/2 T-1, DA-2 ST3)", () => {
  it("offers the request only while unrestricted and shows the state", async () => {
    getMock.mockResolvedValue({ state: "unrestricted" });
    render(<ProfileActivationSettingsSection />);
    expect(
      screen.getByTestId("profile-activation-settings-state"),
    ).toHaveTextContent(ja.settings.state.loading);
    expect(
      await screen.findByTestId("profile-activation-request"),
    ).toHaveTextContent(ja.settings.request);
    expect(screen.getByText(ja.settings.description)).toBeInTheDocument();
    expect(
      screen.getByTestId("profile-activation-settings-state"),
    ).toHaveTextContent(ja.settings.state.unrestricted);

    act(() => handlers.forEach((handler) => handler({ state: "activating" })));
    expect(screen.queryByTestId("profile-activation-request")).toBeNull();
    act(() => handlers.forEach((handler) => handler({ state: "restricted" })));
    expect(
      screen.getByTestId("profile-activation-settings-state"),
    ).toHaveTextContent(ja.settings.state.restricted);
    expect(screen.queryByTestId("profile-activation-request")).toBeNull();
  });

  it("shows the unavailable reason and no request", async () => {
    getMock.mockResolvedValue({
      state: "unavailable",
      reason: "participant-timeout",
    });
    render(<ProfileActivationSettingsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      ja.reason["participant-timeout"],
    );
    expect(screen.queryByTestId("profile-activation-request")).toBeNull();
  });

  it("shows nothing to click when the state cannot be read", async () => {
    getMock.mockRejectedValue(new Error("PROFILE_EGRESS_STATUS_UNAVAILABLE"));
    render(<ProfileActivationSettingsSection />);
    await act(async () => {});
    expect(
      screen.getByTestId("profile-activation-settings-state"),
    ).toHaveTextContent(ja.settings.state.unknown);
    expect(screen.queryByTestId("profile-activation-request")).toBeNull();
  });

  it("sends one request per click while one is pending and shows Main's answer", async () => {
    getMock.mockResolvedValue({ state: "unrestricted" });
    const answer = deferred<ProfileActivationRequestResult>();
    requestMock.mockReturnValue(answer.promise);
    render(<ProfileActivationSettingsSection />);
    const button = await screen.findByTestId("profile-activation-request");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(ja.settings.requesting);
    await act(async () => answer.resolve({ status: "not-activated" }));
    expect(screen.getByTestId("profile-activation-result")).toHaveTextContent(
      ja.result["not-activated"],
    );
    expect(button).not.toBeDisabled();
  });

  it.each(PROFILE_ACTIVATION_REQUEST_STATUSES)(
    "has a fixed sentence for the answer %s",
    async (status) => {
      getMock.mockResolvedValue({ state: "unrestricted" });
      requestMock.mockResolvedValue({ status });
      render(<ProfileActivationSettingsSection />);
      fireEvent.click(await screen.findByTestId("profile-activation-request"));
      const result = await screen.findByTestId("profile-activation-result");
      expect(result).toHaveAttribute("data-profile-activation-status", status);
      expect(result).toHaveTextContent(ja.result[status]);
      expect(PROFILE_EGRESS_TRANSLATIONS.en.result[status]).toBeTruthy();
    },
  );

  it("treats a rejected request as refused", async () => {
    getMock.mockResolvedValue({ state: "unrestricted" });
    requestMock.mockRejectedValue(new Error("bridge"));
    render(<ProfileActivationSettingsSection />);
    fireEvent.click(await screen.findByTestId("profile-activation-request"));
    expect(
      await screen.findByTestId("profile-activation-result"),
    ).toHaveAttribute("data-profile-activation-status", "refused");
  });
});

describe("the shared request (useProfileActivationRequest)", () => {
  it("sends one request for two calls in the same render, before pending is drawn (R3-3)", async () => {
    const answer = deferred<ProfileActivationRequestResult>();
    requestMock.mockReturnValue(answer.promise);
    const { result } = renderHook(() => useProfileActivationRequest());
    act(() => {
      result.current.request();
      result.current.request();
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);
    await act(async () => answer.resolve({ status: "cancelled" }));
    expect(result.current).toMatchObject({
      pending: false,
      lastStatus: "cancelled",
    });
    // The next request is sent once the answer came.
    requestMock.mockResolvedValue({ status: "busy" });
    await act(async () => result.current.request());
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing when Main answers after the unmount (R3-2 (a))", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const answer = deferred<ProfileActivationRequestResult>();
      requestMock.mockReturnValue(answer.promise);
      const { result, unmount } = renderHook(() =>
        useProfileActivationRequest(),
      );
      act(() => result.current.request());
      unmount();
      await act(async () => answer.resolve({ status: "activated" }));
      expect(result.current).toMatchObject({ pending: true, lastStatus: null });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("Related Scenes profile-not-restricted guidance (K3/2 T-1)", () => {
  it("makes the same request and does not read the state itself", async () => {
    requestMock.mockResolvedValue({ status: "cancelled" });
    render(<ProfileActivationGuidance />);
    expect(screen.getByRole("status")).toHaveTextContent(
      ja.guidance.graphNeedsRestriction,
    );
    fireEvent.click(screen.getByTestId("profile-activation-request"));
    expect(
      await screen.findByTestId("profile-activation-result"),
    ).toHaveTextContent(ja.result.cancelled);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("hides the button after the activation succeeded", async () => {
    requestMock.mockResolvedValue({ status: "activated" });
    render(<ProfileActivationGuidance />);
    fireEvent.click(screen.getByTestId("profile-activation-request"));
    expect(
      await screen.findByTestId("profile-activation-result"),
    ).toHaveTextContent(ja.result.activated);
    expect(screen.queryByTestId("profile-activation-request")).toBeNull();
  });
});
