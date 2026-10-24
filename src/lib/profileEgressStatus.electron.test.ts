// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getProfileEgressStatus,
  onProfileEgressStatus,
  requestProfileActivation,
} from "./profileEgressStatus";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

function installBridge(bridge: Record<string, unknown>) {
  (window as unknown as Record<string, unknown>).grimodex = {
    shell: "electron",
    ...bridge,
  };
}

describe("profile egress wrapper (DA-2 DR-DA2-9, DR-DA2-16)", () => {
  it("reads the state through the Main command, strictly", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      value: { state: "unavailable", reason: "barrier-timeout" },
    }));
    installBridge({ invoke });
    await expect(getProfileEgressStatus()).resolves.toEqual({
      state: "unavailable",
      reason: "barrier-timeout",
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("get_profile_egress_status");

    installBridge({
      invoke: async () => ({
        ok: true,
        value: { state: "restricted", profileId: "p" },
      }),
    });
    await expect(getProfileEgressStatus()).rejects.toThrow(
      "PROFILE_EGRESS_STATUS_INVALID",
    );
  });

  it("asks for the activation with no arguments and keeps the closed status only", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      value: { status: "not-activated" },
    }));
    installBridge({ invoke });
    await expect(requestProfileActivation()).resolves.toEqual({
      status: "not-activated",
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "request_profile_activation",
    );

    installBridge({
      invoke: async () => ({
        ok: true,
        value: { status: "activated", grantId: "g" },
      }),
    });
    await expect(requestProfileActivation()).resolves.toEqual({
      status: "refused",
    });
    installBridge({ invoke: async () => ({ ok: false, error: "IPC_X" }) });
    await expect(requestProfileActivation()).resolves.toEqual({
      status: "refused",
    });
  });

  it("passes on only payloads inside the union", () => {
    let deliver!: (payload: unknown) => void;
    const unlisten = vi.fn();
    const listen = vi.fn((channel: string, cb: (payload: unknown) => void) => {
      expect(channel).toBe("profile-egress:state");
      deliver = cb;
      return unlisten;
    });
    installBridge({ listen });
    const seen: unknown[] = [];
    const off = onProfileEgressStatus((view) => seen.push(view));
    deliver({ state: "activating" });
    deliver({ state: "restricted", epoch: 2 });
    deliver("restricted");
    expect(seen).toEqual([{ state: "activating" }]);
    off();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("outside Electron there is no gate: unrestricted, and the request is not activated", async () => {
    await expect(getProfileEgressStatus()).resolves.toEqual({
      state: "unrestricted",
    });
    await expect(requestProfileActivation()).resolves.toEqual({
      status: "not-activated",
    });
  });
});
