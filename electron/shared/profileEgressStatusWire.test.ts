/**
 * The closed state and request results the renderer reads (DA-2 DR-DA2-9,
 * DR-DA2-16): nothing outside the union parses.
 */
import { describe, expect, it } from "vitest";

import {
  parseProfileActivationRequestResult,
  parseProfileEgressStatusView,
  PROFILE_ACTIVATION_REQUEST_STATUSES,
  PROFILE_EGRESS_UNAVAILABLE_REASONS,
} from "./profileEgressStatusWire.js";

describe("profile egress status wire", () => {
  it("parses the four states and only them", () => {
    for (const state of ["unrestricted", "activating", "restricted"] as const) {
      expect(parseProfileEgressStatusView({ state })).toEqual({ state });
    }
    for (const reason of PROFILE_EGRESS_UNAVAILABLE_REASONS) {
      expect(
        parseProfileEgressStatusView({ state: "unavailable", reason }),
      ).toEqual({ state: "unavailable", reason });
    }
    for (const value of [
      null,
      "restricted",
      [],
      { state: "restricted", profileId: "p" },
      { state: "restricted", callerEpoch: 1 },
      { state: "unavailable" },
      { state: "unavailable", reason: "/home/user/x" },
      { state: "unavailable", reason: "barrier-timeout", detail: "x" },
      { state: "released" },
    ]) {
      expect(
        parseProfileEgressStatusView(value),
        JSON.stringify(value),
      ).toBeNull();
    }
  });

  it("the reasons and statuses are fixed closed sets", () => {
    expect(PROFILE_EGRESS_UNAVAILABLE_REASONS).toEqual([
      "state-file-unreadable",
      "state-file-unwritable",
      "barrier-timeout",
      "activation-failed",
      "participant-timeout",
      "participant-failed",
      "backend-unavailable",
      "status-invalid",
    ]);
    expect(PROFILE_ACTIVATION_REQUEST_STATUSES).toEqual([
      "activated",
      "cancelled",
      "expired",
      "busy",
      "already-restricted",
      "unavailable",
      "not-activated",
      "refused",
    ]);
  });

  it("parses a request result with the status only", () => {
    expect(parseProfileActivationRequestResult({ status: "busy" })).toEqual({
      status: "busy",
    });
    for (const value of [
      { status: "activated", grantId: "g" },
      { status: "activated", previewId: "p" },
      { status: "approved" },
      {},
      null,
    ]) {
      expect(parseProfileActivationRequestResult(value)).toBeNull();
    }
  });
});
