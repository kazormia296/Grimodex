import { describe, expect, it } from "vitest";

import { isWebGl2GpuBlocked } from "./webgl2GpuStatus.js";

describe("isWebGl2GpuBlocked", () => {
  it.each(["unavailable_off", "disabled_off"])(
    "treats the hardware-off webgl2 status %s as blocked",
    (webgl2) => {
      expect(isWebGl2GpuBlocked({ webgl2 })).toBe(true);
    },
  );

  it.each([
    "enabled",
    "enabled_readback",
    "enabled_force",
    "unavailable_software",
    "disabled_software",
    "disabled_off_ok",
    "",
    "some_future_value",
  ])(
    "treats the webgl2 status %j as not blocked (unknown or usable)",
    (webgl2) => {
      expect(isWebGl2GpuBlocked({ webgl2 })).toBe(false);
    },
  );

  it("treats a missing webgl2 field as not blocked", () => {
    expect(isWebGl2GpuBlocked({ webgl: "disabled_off" })).toBe(false);
    expect(isWebGl2GpuBlocked({})).toBe(false);
  });

  it.each([undefined, null, "disabled_off", 0, true])(
    "treats a non-object status %j as not blocked",
    (status) => {
      expect(isWebGl2GpuBlocked(status)).toBe(false);
    },
  );

  it("treats a non-string webgl2 value as not blocked", () => {
    expect(isWebGl2GpuBlocked({ webgl2: 1 })).toBe(false);
    expect(isWebGl2GpuBlocked({ webgl2: null })).toBe(false);
  });
});
