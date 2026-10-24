// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The real constant (no mock of `./profileActivationAvailability`): while it
// is false the slot creates no element, requests no chunk and calls no IPC
// (D-13 (a); TASK §7 "入口の閉鎖").
const { wrapperCalls, chunkRequests } = vi.hoisted(() => ({
  wrapperCalls: [] as string[],
  chunkRequests: [] as string[],
}));
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: () => {
    wrapperCalls.push("get");
    return Promise.resolve({ state: "restricted" });
  },
  onProfileEgressStatus: () => {
    wrapperCalls.push("subscribe");
    return () => undefined;
  },
  requestProfileActivation: () => {
    wrapperCalls.push("request");
    return Promise.resolve({ status: "not-activated" });
  },
}));
vi.mock("./ProfileEgressStatusIndicator", () => {
  chunkRequests.push("ProfileEgressStatusIndicator");
  return { default: () => <div data-testid="indicator" /> };
});

import { PROFILE_ACTIVATION_UI_ENABLED } from "./profileActivationAvailability";
import { ProfileEgressStatusSlot } from "./ProfileEgressStatusSlot";

describe("profile egress status slot with the real constant", () => {
  it("renders nothing, requests no chunk and makes no IPC call", async () => {
    expect(PROFILE_ACTIVATION_UI_ENABLED).toBe(false);
    const { container } = render(<ProfileEgressStatusSlot />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(chunkRequests).toEqual([]);
    expect(wrapperCalls).toEqual([]);
  });
});
